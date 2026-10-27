import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { ledgerEntries, type LedgerEntry } from '../../db/schema.js';

export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;

export interface CurrencyBalance {
  currency: string;
  /** Exact numeric(12,2) sum as a decimal string; may be negative after clawbacks. */
  balance: string;
  entryCount: number;
}

export class LedgerRepository {
  constructor(private readonly db: Database) {}

  async insertEntries(entries: NewLedgerEntry[]): Promise<LedgerEntry[]> {
    if (entries.length === 0) return [];
    return this.db.insert(ledgerEntries).values(entries).returning();
  }

  async balancesFor(influencerSlug: string): Promise<CurrencyBalance[]> {
    return this.db
      .select({
        currency: ledgerEntries.currency,
        balance: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)::numeric(14, 2)::text`,
        entryCount: sql<number>`COUNT(*)::int`,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.influencerSlug, influencerSlug))
      .groupBy(ledgerEntries.currency)
      .orderBy(ledgerEntries.currency);
  }

  async entriesFor(influencerSlug: string, limit = 100): Promise<LedgerEntry[]> {
    return this.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.influencerSlug, influencerSlug))
      .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
      .limit(limit);
  }
}
