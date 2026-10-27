import type { Database } from '../../db/client.js';
import type { LedgerEntry } from '../../db/schema.js';
import { centsToDecimal, decimalToCents } from '../../lib/money.js';
import { LedgerRepository, type CurrencyBalance } from './ledger.repository.js';

/** The minimum a payout must carry to be posted to the ledger. */
export interface PostablePayout {
  id: string;
  amount: string;
  currency: string;
  influencerSlug: string;
}

export interface InfluencerBalance {
  influencer_slug: string;
  balances: { currency: string; balance: string; entry_count: number; is_negative: boolean }[];
}

/**
 * Posts to the append-only influencer ledger. Construct it on a transaction
 * handle (`new LedgerService(tx)`) so postings commit atomically with the
 * payout status change that caused them.
 */
export class LedgerService {
  private readonly repo: LedgerRepository;

  constructor(db: Database) {
    this.repo = new LedgerRepository(db);
  }

  /** Credits matured escrow: +amount per payout. */
  postEscrowReleases(payouts: PostablePayout[], at: Date): Promise<LedgerEntry[]> {
    return this.repo.insertEntries(
      payouts.map((p) => ({
        influencerSlug: p.influencerSlug,
        payoutId: p.id,
        entryType: 'escrow_release' as const,
        amount: p.amount,
        currency: p.currency,
        description: `Escrow matured for payout ${p.id}`,
        createdAt: at,
      })),
    );
  }

  /** Debits a released payout after a refund/chargeback: −amount. The balance may go negative. */
  async postClawback(payout: PostablePayout, reason: string, at: Date): Promise<LedgerEntry> {
    const [entry] = await this.repo.insertEntries([
      {
        influencerSlug: payout.influencerSlug,
        payoutId: payout.id,
        entryType: 'clawback',
        amount: centsToDecimal(-decimalToCents(payout.amount)),
        currency: payout.currency,
        description: `Clawback of payout ${payout.id} (${reason})`,
        createdAt: at,
      },
    ]);
    return entry!;
  }

  async getBalance(influencerSlug: string): Promise<InfluencerBalance> {
    const rows: CurrencyBalance[] = await this.repo.balancesFor(influencerSlug);
    return {
      influencer_slug: influencerSlug,
      balances: rows.map((r) => ({
        currency: r.currency,
        balance: r.balance,
        entry_count: r.entryCount,
        is_negative: decimalToCents(r.balance) < 0n,
      })),
    };
  }

  getEntries(influencerSlug: string, limit?: number): Promise<LedgerEntry[]> {
    return this.repo.entriesFor(influencerSlug, limit);
  }
}
