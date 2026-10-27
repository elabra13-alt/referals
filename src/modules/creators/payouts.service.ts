import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { isUniqueViolation, type Database } from '../../db/client.js';
import {
  creators,
  links,
  payouts,
  withdrawalRequests,
  type Creator,
  type WithdrawalRequest,
  type WithdrawalStatus,
} from '../../db/schema.js';
import { maskClabe, resolveBank } from '../../lib/clabe.js';
import { AppError } from '../../lib/errors.js';
import { centsToDecimal, decimalToCents } from '../../lib/money.js';
import { LedgerRepository } from '../ledger/ledger.repository.js';
import type { CreatorPatch, CreatorsRepository } from './creators.repository.js';

export const PAYOUT_CURRENCY = 'MXN';
/** Smallest withdrawal (SPEI fees make tiny transfers uneconomic). */
export const MIN_WITHDRAWAL_CENTS = 10_000n; // $100.00 MXN
/** After a payout CLABE is replaced, withdrawals pause this long (account-takeover protection). */
export const CLABE_CHANGE_COOLING_OFF_MS = 24 * 60 * 60 * 1000;

const IN_FLIGHT: WithdrawalStatus[] = ['pending', 'processing'];

export interface PayoutProfileDto {
  clabe_masked: string | null;
  bank_code: string | null;
  bank_name: string | null;
  legal_name: string | null;
  rfc: string | null;
  /** CLABE and legal name are both on file. */
  payout_ready: boolean;
  /** Set while a recent CLABE change is cooling off: withdrawals open again at this time. */
  withdrawals_available_at: string | null;
}

export interface BalanceDto {
  currency: 'MXN';
  /** Released commissions minus clawbacks and withdrawals: what can be withdrawn now (may be negative). */
  available_balance_cents: number;
  /** Attributed commissions still inside their escrow window. */
  pending_escrow_balance_cents: number;
  /** All commissions earned and not reversed (released + still in escrow). */
  lifetime_earnings_cents: number;
  /** Withdrawals requested but not yet paid out (already deducted from available). */
  withdrawals_in_progress_cents: number;
  is_negative: boolean;
}

export interface WithdrawalDto {
  id: string;
  amount_cents: number;
  amount: string;
  currency: string;
  status: WithdrawalStatus;
  destination: { clabe_masked: string; bank_code: string; bank_name: string | null; beneficiary_name: string };
  tracking_key: string | null;
  failure_reason: string | null;
  requested_at: string;
  processed_at: string | null;
}

const sumCents = (value: string | null | undefined) => Number(decimalToCents(value ?? '0'));

export function toWithdrawalDto(w: WithdrawalRequest): WithdrawalDto {
  return {
    id: w.id,
    amount_cents: sumCents(w.amount),
    amount: w.amount,
    currency: w.currency,
    status: w.status,
    destination: { clabe_masked: maskClabe(w.clabe), bank_code: w.bankCode, bank_name: w.bankName, beneficiary_name: w.beneficiaryName },
    tracking_key: w.trackingKey,
    failure_reason: w.failureReason,
    requested_at: w.requestedAt.toISOString(),
    processed_at: w.processedAt?.toISOString() ?? null,
  };
}

/**
 * Creator balances and SPEI withdrawals.
 *
 * The immutable ledger is the source of truth for money that can move:
 * escrow releases credit it, clawbacks and withdrawals debit it. A withdrawal
 * request debits the ledger and records the request in one transaction, with
 * the creator row locked, so concurrent requests can never spend the same
 * balance twice. The actual SPEI transfer (pending → processing → paid/failed)
 * is an operations step outside this API.
 */
export class PayoutsService {
  constructor(
    private readonly deps: {
      db: Database;
      creatorsRepo: CreatorsRepository;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private coolingOffUntil(creator: Pick<Creator, 'speiClabeChangedAt'>): Date | null {
    if (!creator.speiClabeChangedAt) return null;
    const until = new Date(creator.speiClabeChangedAt.getTime() + CLABE_CHANGE_COOLING_OFF_MS);
    return until.getTime() > this.now().getTime() ? until : null;
  }

  // ---------- Payout profile ----------

  toProfileDto(creator: Creator): PayoutProfileDto {
    const bank = creator.speiClabe ? resolveBank(creator.speiClabe) : null;
    return {
      clabe_masked: creator.speiClabe ? maskClabe(creator.speiClabe) : null,
      bank_code: bank?.bankCode ?? null,
      bank_name: bank?.bankName ?? null,
      legal_name: creator.payoutLegalName,
      rfc: creator.rfc,
      payout_ready: Boolean(creator.speiClabe && creator.payoutLegalName),
      withdrawals_available_at: this.coolingOffUntil(creator)?.toISOString() ?? null,
    };
  }

  async updateProfile(creator: Creator, input: { clabe: string; legal_name: string; rfc: string | null }): Promise<PayoutProfileDto> {
    const patch: CreatorPatch = { speiClabe: input.clabe, payoutLegalName: input.legal_name, rfc: input.rfc };
    // First registration is immediate; replacing an existing account starts the cooling-off.
    if (creator.speiClabe && creator.speiClabe !== input.clabe) patch.speiClabeChangedAt = this.now();
    return this.toProfileDto(await this.deps.creatorsRepo.updateCreator(creator.id, patch));
  }

  // ---------- Balance ----------

  private async availableCents(db: Database, creatorSlug: string): Promise<bigint> {
    const balances = await new LedgerRepository(db).balancesFor(creatorSlug);
    return decimalToCents(balances.find((b) => b.currency === PAYOUT_CURRENCY)?.balance ?? '0');
  }

  async balance(creator: Creator): Promise<BalanceDto> {
    const { db } = this.deps;
    const [available, [payoutSums], [inFlight]] = await Promise.all([
      this.availableCents(db, creator.slug),
      db
        .select({
          pending: sql<string>`COALESCE(SUM(${payouts.amount}) FILTER (WHERE ${payouts.status} = 'in_escrow'), 0)::text`,
          lifetime: sql<string>`COALESCE(SUM(${payouts.amount}) FILTER (WHERE ${payouts.status} IN ('in_escrow', 'released')), 0)::text`,
        })
        .from(payouts)
        .innerJoin(links, eq(links.id, payouts.linkId))
        .where(and(eq(links.influencerSlug, creator.slug), eq(payouts.currency, PAYOUT_CURRENCY))),
      db
        .select({ total: sql<string>`COALESCE(SUM(${withdrawalRequests.amount}), 0)::text` })
        .from(withdrawalRequests)
        .where(and(eq(withdrawalRequests.creatorId, creator.id), inArray(withdrawalRequests.status, IN_FLIGHT))),
    ]);
    return {
      currency: 'MXN',
      available_balance_cents: Number(available),
      pending_escrow_balance_cents: sumCents(payoutSums?.pending),
      lifetime_earnings_cents: sumCents(payoutSums?.lifetime),
      withdrawals_in_progress_cents: sumCents(inFlight?.total),
      is_negative: available < 0n,
    };
  }

  // ---------- Withdrawals ----------

  private async findByIdempotencyKey(creatorId: string, key: string): Promise<WithdrawalRequest | null> {
    const [row] = await this.deps.db
      .select()
      .from(withdrawalRequests)
      .where(and(eq(withdrawalRequests.creatorId, creatorId), eq(withdrawalRequests.idempotencyKey, key)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Debits the ledger and records a pending SPEI withdrawal, atomically.
   * `amountCents` omitted = withdraw the full available balance.
   */
  async requestWithdrawal(
    creator: Creator,
    input: { amountCents: bigint | null; idempotencyKey: string | null },
  ): Promise<{ created: boolean; withdrawal: WithdrawalDto }> {
    if (input.idempotencyKey) {
      const previous = await this.findByIdempotencyKey(creator.id, input.idempotencyKey);
      if (previous) return { created: false, withdrawal: toWithdrawalDto(previous) };
    }

    try {
      const withdrawal = await this.deps.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        // Serialize all withdrawals of this creator; re-read profile state under the lock.
        const [locked] = await tx.select().from(creators).where(eq(creators.id, creator.id)).for('update');
        if (!locked) throw new AppError(404, 'CREATOR_NOT_FOUND', 'Creator not found.');
        if (!locked.speiClabe || !locked.payoutLegalName) {
          throw new AppError(409, 'PAYOUT_PROFILE_INCOMPLETE', 'Register your CLABE and legal name before withdrawing.');
        }
        const coolingOff = this.coolingOffUntil(locked);
        if (coolingOff) {
          throw new AppError(409, 'PAYOUT_ACCOUNT_COOLING_OFF', 'Your payout account changed recently; withdrawals reopen soon.', {
            withdrawals_available_at: coolingOff.toISOString(),
          });
        }

        const available = await this.availableCents(tx, locked.slug);
        const amount = input.amountCents ?? available;
        if (amount <= 0n || amount > available) {
          throw new AppError(409, 'INSUFFICIENT_FUNDS', 'The requested amount exceeds your available balance.', {
            available_balance_cents: Number(available),
            requested_cents: Number(amount),
          });
        }
        if (amount < MIN_WITHDRAWAL_CENTS) {
          throw new AppError(422, 'BELOW_MINIMUM_WITHDRAWAL', 'The minimum withdrawal is $100.00 MXN.', {
            minimum_cents: Number(MIN_WITHDRAWAL_CENTS),
          });
        }

        const now = this.now();
        const bank = resolveBank(locked.speiClabe);
        const [entry] = await new LedgerRepository(tx).insertEntries([
          {
            influencerSlug: locked.slug,
            entryType: 'withdrawal_adjustment',
            amount: centsToDecimal(-amount),
            currency: PAYOUT_CURRENCY,
            description: `SPEI withdrawal to ${bank.bankName ?? `bank ${bank.bankCode}`} ${maskClabe(locked.speiClabe)}`,
            createdAt: now,
          },
        ]);
        const [row] = await tx
          .insert(withdrawalRequests)
          .values({
            creatorId: locked.id,
            amount: centsToDecimal(amount),
            currency: PAYOUT_CURRENCY,
            status: 'pending',
            clabe: locked.speiClabe,
            bankCode: bank.bankCode,
            bankName: bank.bankName,
            beneficiaryName: locked.payoutLegalName,
            rfc: locked.rfc,
            ledgerEntryId: entry!.id,
            idempotencyKey: input.idempotencyKey,
            requestedAt: now,
          })
          .returning();
        return row!;
      });
      return { created: true, withdrawal: toWithdrawalDto(withdrawal) };
    } catch (err) {
      // Same Idempotency-Key raced in concurrently: the first one won (and rolled ours back).
      if (input.idempotencyKey && isUniqueViolation(err, 'withdrawals_creator_idempotency_key_idx')) {
        const winner = await this.findByIdempotencyKey(creator.id, input.idempotencyKey);
        if (winner) return { created: false, withdrawal: toWithdrawalDto(winner) };
      }
      throw err;
    }
  }

  async listWithdrawals(creator: Creator): Promise<{ data: WithdrawalDto[] }> {
    const rows = await this.deps.db
      .select()
      .from(withdrawalRequests)
      .where(eq(withdrawalRequests.creatorId, creator.id))
      .orderBy(desc(withdrawalRequests.requestedAt), desc(withdrawalRequests.id));
    return { data: rows.map(toWithdrawalDto) };
  }
}
