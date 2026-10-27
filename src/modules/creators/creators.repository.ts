import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { campaigns, creators, links, payouts, products, type Creator, type CreatorNiche, type Link } from '../../db/schema.js';

export type NewCreator = Omit<typeof creators.$inferInsert, 'id' | 'createdAt' | 'status'>;
export type CreatorPatch = Partial<
  Pick<
    Creator,
    | 'handle'
    | 'name'
    | 'speiClabe'
    | 'speiClabeChangedAt'
    | 'payoutLegalName'
    | 'rfc'
    | 'bio'
    | 'avatarUrl'
    | 'instagramHandle'
    | 'tiktokHandle'
    | 'phone'
    | 'whatsappOptInAt'
  >
>;

export interface CreatorLinkRow {
  link: Link;
  campaignStatus: string;
  productName: string;
  checkoutBaseUrl: string;
}

export type NewLink = Omit<typeof links.$inferInsert, 'id' | 'createdAt'>;

export interface PendingEscrow {
  currency: string;
  amount: string;
  payoutCount: number;
  nextReleaseAt: Date | null;
}

/** Upper bound on candidates scored per matching request. */
const MATCH_CANDIDATE_POOL = 2_000;

export class CreatorsRepository {
  constructor(private readonly db: Database) {}

  // ---------- Creators ----------

  async insertCreator(values: NewCreator): Promise<Creator> {
    const [row] = await this.db.insert(creators).values(values).returning();
    if (!row) throw new Error('Insert into creators returned no row');
    return row;
  }

  async findCreatorBySlug(slug: string): Promise<Creator | null> {
    const [row] = await this.db.select().from(creators).where(eq(creators.slug, slug)).limit(1);
    return row ?? null;
  }

  async findCreatorByApiKeyHash(apiKeyHash: string): Promise<Creator | null> {
    const [row] = await this.db.select().from(creators).where(eq(creators.apiKeyHash, apiKeyHash)).limit(1);
    return row ?? null;
  }

  async updateCreator(creatorId: string, patch: CreatorPatch): Promise<Creator> {
    const [row] = await this.db.update(creators).set(patch).where(eq(creators.id, creatorId)).returning();
    if (!row) throw new Error('Update of creators returned no row');
    return row;
  }

  async setApiKeyHash(creatorId: string, apiKeyHash: string): Promise<void> {
    await this.db.update(creators).set({ apiKeyHash }).where(eq(creators.id, creatorId));
  }

  /**
   * Every link credited to this creator. Matches on influencer_slug (the key
   * the ledger and codes use), which also covers links that predate creator profiles.
   */
  async listCreatorLinks(influencerSlug: string): Promise<CreatorLinkRow[]> {
    return this.db
      .select({
        link: links,
        campaignStatus: campaigns.status,
        productName: products.name,
        checkoutBaseUrl: products.checkoutBaseUrl,
      })
      .from(links)
      .innerJoin(campaigns, eq(campaigns.id, links.campaignId))
      .innerJoin(products, eq(products.id, campaigns.productId))
      .where(eq(links.influencerSlug, influencerSlug))
      .orderBy(desc(links.createdAt), desc(links.id));
  }

  /** Active creators to score, most engaged first so the pool cap keeps the strongest. */
  async listMatchCandidates(opts: { niche?: CreatorNiche | undefined } = {}): Promise<Creator[]> {
    const filters: SQL[] = [eq(creators.status, 'active')];
    if (opts.niche) filters.push(eq(creators.niche, opts.niche));
    return this.db
      .select()
      .from(creators)
      .where(and(...filters))
      .orderBy(desc(creators.engagementRate), asc(creators.slug))
      .limit(MATCH_CANDIDATE_POOL);
  }

  // ---------- Links ----------

  async findLinkForCreator(campaignId: string, creatorId: string): Promise<Link | null> {
    const [row] = await this.db
      .select()
      .from(links)
      .where(and(eq(links.campaignId, campaignId), eq(links.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  }

  async linkSlugExists(linkSlug: string): Promise<boolean> {
    const [row] = await this.db.select({ id: links.id }).from(links).where(eq(links.linkSlug, linkSlug)).limit(1);
    return row !== undefined;
  }

  async insertLink(values: NewLink): Promise<Link> {
    const [row] = await this.db.insert(links).values(values).returning();
    if (!row) throw new Error('Insert into links returned no row');
    return row;
  }

  async listCampaignLinks(campaignId: string): Promise<Link[]> {
    return this.db.select().from(links).where(eq(links.campaignId, campaignId)).orderBy(desc(links.createdAt), desc(links.id));
  }

  async linkedCreatorIds(campaignId: string): Promise<Set<string>> {
    const rows = await this.db.select({ creatorId: links.creatorId }).from(links).where(eq(links.campaignId, campaignId));
    return new Set(rows.map((r) => r.creatorId).filter((id): id is string => id !== null));
  }

  async countLinks(influencerSlug: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(links)
      .where(eq(links.influencerSlug, influencerSlug));
    return row?.n ?? 0;
  }

  // ---------- Balances ----------

  /** Payouts still in escrow, i.e. not yet credited to the ledger. */
  async pendingEscrow(influencerSlug: string): Promise<PendingEscrow[]> {
    return this.db
      .select({
        currency: payouts.currency,
        amount: sql<string>`COALESCE(SUM(${payouts.amount}), 0)::numeric(14, 2)::text`,
        payoutCount: sql<number>`COUNT(*)::int`,
        nextReleaseAt: sql<Date | null>`MIN(${payouts.escrowUntil})`.mapWith((v: string | Date | null) =>
          v === null ? null : new Date(v),
        ),
      })
      .from(payouts)
      .innerJoin(links, eq(links.id, payouts.linkId))
      .where(and(eq(links.influencerSlug, influencerSlug), eq(payouts.status, 'in_escrow')))
      .groupBy(payouts.currency)
      .orderBy(payouts.currency);
  }
}
