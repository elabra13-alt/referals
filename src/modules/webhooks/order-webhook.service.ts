import type { FastifyBaseLogger } from 'fastify';
import { isUniqueViolation } from '../../db/client.js';
import type { Payout } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { centsToDecimal, commissionCents, platformFeeCents } from '../../lib/money.js';
import type { RedisClient } from '../../lib/redis.js';
import { LockNotAcquiredError, withRedisLock } from '../../lib/redis-lock.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { decideAttribution, type AttributionReason } from './attribution.js';
import { computeEscrowUntil, escrowDaysForCategory } from './escrow.js';
import type { OrdersRepository } from './orders.repository.js';
import type { OrderPaidPayload, OrderRefundedPayload } from './webhooks.schemas.js';

export const ORDER_LOCK_TTL_MS = 60_000;
/** How long a duplicate delivery waits for an in-flight one before answering 409. */
const ORDER_LOCK_MAX_WAIT_MS = 2_000;
const SALES_ORDER_UNIQUE = 'sales_seller_id_seller_order_id_unique';

export interface PayoutDto {
  payout_id: string;
  amount: string;
  currency: string;
  commission_rate: string;
  platform_fee_rate: string;
  platform_fee_amount: string;
  escrow_days: number;
  escrow_until: string;
  status: string;
}

export type PaidResult =
  | { status: 'already_processed'; sale_id: string }
  | {
      status: 'processed';
      sale_id: string;
      attribution: { attributed: boolean; reason: AttributionReason; code: string | null };
      payout: PayoutDto | null;
    };

export type RefundResult =
  | { status: 'already_processed'; sale_id: string }
  | {
      status: 'processed';
      sale_id: string;
      sale_status: 'refunded';
      payouts: {
        payout_id: string;
        status: string;
        clawback: { ledger_entry_id: string; amount: string; currency: string } | null;
      }[];
    };

function toPayoutDto(p: Payout): PayoutDto {
  return {
    payout_id: p.id,
    amount: p.amount,
    currency: p.currency,
    commission_rate: p.commissionRate,
    platform_fee_rate: p.platformFeeRate,
    platform_fee_amount: p.platformFeeAmount,
    escrow_days: p.escrowDays,
    escrow_until: p.escrowUntil.toISOString(),
    status: p.status,
  };
}

export class OrderWebhookService {
  constructor(
    private readonly deps: {
      repo: OrdersRepository;
      redis: RedisClient;
      log: FastifyBaseLogger;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Serializes every webhook touching one order; duplicates wait, then see the committed sale. */
  private withOrderLock<T>(sellerId: string, sellerOrderId: string, fn: () => Promise<T>): Promise<T> {
    const key = `lock:order:${sellerId}:${sellerOrderId}`;
    return withRedisLock(this.deps.redis, [key], { ttlMs: ORDER_LOCK_TTL_MS, maxWaitMs: ORDER_LOCK_MAX_WAIT_MS }, fn).catch(
      (err: unknown) => {
        if (err instanceof LockNotAcquiredError) {
          throw new AppError(409, 'ORDER_IN_FLIGHT', 'This order is currently being processed. Retry shortly.', undefined, {
            'Retry-After': '5',
          });
        }
        throw err;
      },
    );
  }

  async processPaid(sellerId: string, payload: OrderPaidPayload): Promise<PaidResult> {
    const { repo, log } = this.deps;
    return this.withOrderLock(sellerId, payload.seller_order_id, async () => {
      const existing = await repo.findSaleByOrder(sellerId, payload.seller_order_id);
      if (existing) return { status: 'already_processed', sale_id: existing.id };

      const receivedAt = this.now();
      // A future-dated timestamp can't push a sale outside the grace window.
      const orderedAt = payload.timestamp < receivedAt ? payload.timestamp : receivedAt;

      try {
        return await repo.transaction(async (tx): Promise<PaidResult> => {
          const code = payload.applied_discount_code ? await tx.findCodeForAttribution(payload.applied_discount_code) : null;
          const decision = decideAttribution({ submittedCode: payload.applied_discount_code, code, sellerId, orderedAt });

          const sale = await tx.insertSale({
            sellerId,
            sellerOrderId: payload.seller_order_id,
            appliedDiscountCode: payload.applied_discount_code,
            codeId: code?.codeId ?? null,
            attributed: decision.attributed,
            attributionReason: decision.reason,
            currency: payload.currency,
            grossTotal: centsToDecimal(payload.financials.gross_total),
            discountTotal: centsToDecimal(payload.financials.discount_total),
            netTotal: centsToDecimal(payload.financials.net_total),
            customerEmail: payload.customer?.email ?? null,
            status: 'paid',
            orderedAt,
            createdAt: receivedAt,
          });

          let payout: Payout | null = null;
          if (decision.attributed && code) {
            await tx.markCodeApplied(code.codeId, receivedAt);
            const escrowDays = escrowDaysForCategory(code.category);
            const feeCents = platformFeeCents(payload.financials.net_total, code.platformFeeRate);
            payout = await tx.insertPayout({
              saleId: sale.id,
              codeId: code.codeId,
              linkId: code.linkId,
              amount: centsToDecimal(commissionCents(payload.financials.net_total, code.commissionRate)),
              currency: payload.currency,
              commissionRate: code.commissionRate,
              platformFeeRate: code.platformFeeRate,
              platformFeeAmount: centsToDecimal(feeCents),
              escrowDays,
              escrowUntil: computeEscrowUntil(sale.createdAt, escrowDays),
              status: 'in_escrow',
            });
            log.info(
              {
                saleId: sale.id,
                payoutId: payout.id,
                platformFeeRate: payout.platformFeeRate,
                platformFeeAmount: payout.platformFeeAmount,
                currency: payout.currency,
              },
              'platform fee accrued',
            );
          }

          return {
            status: 'processed',
            sale_id: sale.id,
            attribution: { attributed: decision.attributed, reason: decision.reason, code: code?.code ?? null },
            payout: payout ? toPayoutDto(payout) : null,
          };
        });
      } catch (err) {
        // Last line of defense if the Redis lock expired mid-flight: the DB constraint wins.
        if (isUniqueViolation(err, SALES_ORDER_UNIQUE)) {
          const winner = await repo.findSaleByOrder(sellerId, payload.seller_order_id);
          if (winner) return { status: 'already_processed', sale_id: winner.id };
        }
        throw err;
      }
    });
  }

  async processRefund(sellerId: string, payload: OrderRefundedPayload): Promise<RefundResult> {
    const { repo, log } = this.deps;
    return this.withOrderLock(sellerId, payload.seller_order_id, () =>
      repo.transaction(async (tx, txDb): Promise<RefundResult> => {
        const sale = await tx.findSaleByOrder(sellerId, payload.seller_order_id, { forUpdate: true });
        if (!sale) {
          // 404 makes the sender retry, which covers refund-before-paid delivery races.
          throw new AppError(404, 'SALE_NOT_FOUND', 'No paid order with this seller_order_id has been received.');
        }
        if (sale.status === 'refunded') return { status: 'already_processed', sale_id: sale.id };

        const now = this.now();
        await tx.markSaleRefunded(sale.id, now, payload.event);

        const payouts = await tx.lockPayoutsForSale(sale.id);
        await tx.cancelPayouts(
          payouts.filter((p) => p.status === 'in_escrow').map((p) => p.id),
          now,
        );

        // Escrow already matured: debit the influencer ledger (the balance may go negative).
        const ledger = new LedgerService(txDb);
        const clawbacks = new Map<string, { ledger_entry_id: string; amount: string; currency: string }>();
        for (const p of payouts.filter((x) => x.status === 'released')) {
          await tx.markPayoutClawedBack(p.id, now);
          const entry = await ledger.postClawback(p, payload.event, now);
          clawbacks.set(p.id, { ledger_entry_id: entry.id, amount: entry.amount, currency: entry.currency });
          log.info({ saleId: sale.id, payoutId: p.id, amount: entry.amount }, 'released payout clawed back');
        }

        const statusAfter = (status: string) =>
          status === 'in_escrow' ? 'cancelled' : status === 'released' ? 'clawed_back' : status;
        return {
          status: 'processed',
          sale_id: sale.id,
          sale_status: 'refunded',
          payouts: payouts.map((p) => ({
            payout_id: p.id,
            status: statusAfter(p.status),
            clawback: clawbacks.get(p.id) ?? null,
          })),
        };
      }),
    );
  }
}
