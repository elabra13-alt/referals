import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  campaigns,
  codes,
  links,
  payouts,
  products,
  sales,
  sellers,
  type Payout,
  type Sale,
  type Seller,
} from '../../db/schema.js';
import type { AttributableCode } from './attribution.js';

export interface CodeForAttribution extends AttributableCode {
  category: string;
  commissionRate: string;
  platformFeeRate: string;
}

export type PayoutWithInfluencer = Payout & { influencerSlug: string };

export type NewSale = typeof sales.$inferInsert;
export type NewPayout = typeof payouts.$inferInsert;

export class OrdersRepository {
  constructor(private readonly db: Database) {}

  /** Runs `fn` in a DB transaction with a repository (and the raw handle, for other repos) bound to it. */
  transaction<T>(fn: (repo: OrdersRepository, tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction((rawTx) => {
      const tx = rawTx as unknown as Database;
      return fn(new OrdersRepository(tx), tx);
    });
  }

  async findSeller(sellerId: string): Promise<Pick<Seller, 'id' | 'webhookSecret' | 'status'> | null> {
    const [row] = await this.db
      .select({ id: sellers.id, webhookSecret: sellers.webhookSecret, status: sellers.status })
      .from(sellers)
      .where(eq(sellers.id, sellerId))
      .limit(1);
    return row ?? null;
  }

  async findSaleByOrder(sellerId: string, sellerOrderId: string, opts: { forUpdate?: boolean } = {}): Promise<Sale | null> {
    const query = this.db
      .select()
      .from(sales)
      .where(and(eq(sales.sellerId, sellerId), eq(sales.sellerOrderId, sellerOrderId)))
      .limit(1);
    const [row] = opts.forUpdate ? await query.for('update') : await query;
    return row ?? null;
  }

  /** Row-locks the code so two different orders can't both consume a single-use code. */
  async findCodeForAttribution(code: string): Promise<CodeForAttribution | null> {
    const [row] = await this.db
      .select({
        codeId: codes.id,
        code: codes.code,
        status: codes.status,
        expiresAt: codes.expiresAt,
        linkId: codes.linkId,
        sellerId: products.sellerId,
        category: products.category,
        commissionRate: campaigns.commissionRate,
        platformFeeRate: campaigns.platformFeeRate,
      })
      .from(codes)
      .innerJoin(links, eq(links.id, codes.linkId))
      .innerJoin(campaigns, eq(campaigns.id, links.campaignId))
      .innerJoin(products, eq(products.id, campaigns.productId))
      .where(eq(codes.code, code))
      .limit(1)
      .for('update', { of: codes });
    return row ?? null;
  }

  async insertSale(sale: NewSale): Promise<Sale> {
    const [row] = await this.db.insert(sales).values(sale).returning();
    if (!row) throw new Error('Insert into sales returned no row');
    return row;
  }

  async markCodeApplied(codeId: string, appliedAt: Date): Promise<void> {
    await this.db.update(codes).set({ status: 'applied', appliedAt }).where(eq(codes.id, codeId));
  }

  async insertPayout(payout: NewPayout): Promise<Payout> {
    const [row] = await this.db.insert(payouts).values(payout).returning();
    if (!row) throw new Error('Insert into payouts returned no row');
    return row;
  }

  async markSaleRefunded(saleId: string, refundedAt: Date, event: string): Promise<void> {
    await this.db.update(sales).set({ status: 'refunded', refundedAt, refundEvent: event }).where(eq(sales.id, saleId));
  }

  /**
   * Row-locks a sale's payouts. Blocks on (rather than skips) rows the escrow
   * worker holds, so a refund always sees the post-release status.
   */
  async lockPayoutsForSale(saleId: string): Promise<PayoutWithInfluencer[]> {
    const rows = await this.db
      .select({ payout: payouts, influencerSlug: links.influencerSlug })
      .from(payouts)
      .innerJoin(links, eq(links.id, payouts.linkId))
      .where(eq(payouts.saleId, saleId))
      .for('update', { of: payouts });
    return rows.map((r) => ({ ...r.payout, influencerSlug: r.influencerSlug }));
  }

  async cancelPayouts(payoutIds: string[], cancelledAt: Date): Promise<void> {
    if (payoutIds.length === 0) return;
    await this.db
      .update(payouts)
      .set({ status: 'cancelled', cancelledAt })
      .where(and(inArray(payouts.id, payoutIds), eq(payouts.status, 'in_escrow')));
  }

  async markPayoutClawedBack(payoutId: string, clawedBackAt: Date): Promise<void> {
    await this.db
      .update(payouts)
      .set({ status: 'clawed_back', clawedBackAt })
      .where(and(eq(payouts.id, payoutId), eq(payouts.status, 'released')));
  }
}
