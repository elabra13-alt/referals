/** Dynamic Category Escrow (AGENTS.md §5), in natural days. */
export const DEFAULT_ESCROW_DAYS = 21;

const ESCROW_DAYS_BY_CATEGORY: ReadonlyMap<string, number> = new Map([
  ['beauty', 14],
  ['skincare', 14],
  ['consumables', 14],
  ['general', 21],
  ['home', 21],
  ['electronics', 25],
  ['audio', 25],
  ['fashion', 28],
  ['footwear', 28],
  ['apparel', 28],
]);

export function escrowDaysForCategory(category: string | null | undefined): number {
  if (!category) return DEFAULT_ESCROW_DAYS;
  return ESCROW_DAYS_BY_CATEGORY.get(category.trim().toLowerCase()) ?? DEFAULT_ESCROW_DAYS;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `sale.created_at + INTERVAL '{days} days'` (timestamps are UTC, so a day is 24h). */
export function computeEscrowUntil(saleCreatedAt: Date, escrowDays: number): Date {
  return new Date(saleCreatedAt.getTime() + escrowDays * DAY_MS);
}
