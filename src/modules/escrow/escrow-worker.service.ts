import { and, eq, inArray, lte } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client.js';
import { links, payouts, sales } from '../../db/schema.js';
import { LedgerService } from '../ledger/ledger.service.js';

export interface EscrowRunResult {
  released: number;
  batches: number;
}

export interface EscrowWorkerOptions {
  db: Database;
  log: Pick<FastifyBaseLogger, 'info' | 'error'>;
  now?: () => Date;
  batchSize?: number;
  /** Safety valve so one run can't monopolize the DB. */
  maxBatchesPerRun?: number;
}

/**
 * Releases matured escrow: every `in_escrow` payout whose `escrow_until` has
 * passed (and whose sale is still `paid`) moves to `released` and is credited
 * to the influencer ledger in the same transaction.
 *
 * Safe to run on several instances at once: batches are claimed with
 * `FOR UPDATE SKIP LOCKED`, and the ledger's unique (payout_id, entry_type)
 * index makes a double release impossible.
 */
export class EscrowWorkerService {
  private readonly batchSize: number;
  private readonly maxBatchesPerRun: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = true;

  constructor(private readonly opts: EscrowWorkerOptions) {
    this.batchSize = opts.batchSize ?? 500;
    this.maxBatchesPerRun = opts.maxBatchesPerRun ?? 100;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** Processes one batch; returns how many payouts were released. */
  async processBatch(): Promise<number> {
    const now = this.now();
    return this.opts.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      const due = await db
        .select({
          id: payouts.id,
          amount: payouts.amount,
          currency: payouts.currency,
          influencerSlug: links.influencerSlug,
        })
        .from(payouts)
        .innerJoin(sales, eq(sales.id, payouts.saleId))
        .innerJoin(links, eq(links.id, payouts.linkId))
        .where(and(eq(payouts.status, 'in_escrow'), lte(payouts.escrowUntil, now), eq(sales.status, 'paid')))
        .orderBy(payouts.escrowUntil, payouts.id)
        .limit(this.batchSize)
        .for('update', { of: payouts, skipLocked: true });

      if (due.length === 0) return 0;

      await db
        .update(payouts)
        .set({ status: 'released', releasedAt: now })
        .where(
          and(
            inArray(
              payouts.id,
              due.map((p) => p.id),
            ),
            eq(payouts.status, 'in_escrow'),
          ),
        );
      await new LedgerService(db).postEscrowReleases(due, now);
      return due.length;
    });
  }

  /** Drains all currently matured payouts (bounded by maxBatchesPerRun). */
  async runOnce(): Promise<EscrowRunResult> {
    let released = 0;
    let batches = 0;
    while (batches < this.maxBatchesPerRun) {
      const count = await this.processBatch();
      if (count === 0) break;
      released += count;
      batches++;
      if (count < this.batchSize) break;
    }
    if (released > 0) this.opts.log.info({ released, batches }, 'escrow payouts released');
    return { released, batches };
  }

  /** Polls every `intervalMs`; runs never overlap within one process. */
  start(intervalMs: number): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      this.running = this.runOnce().catch((err: unknown) => this.opts.log.error({ err }, 'escrow worker run failed'));
      await this.running;
      if (!this.stopped) this.timer = setTimeout(tick, intervalMs);
    };
    void tick();
  }

  /** Stops polling and waits for an in-flight run to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
