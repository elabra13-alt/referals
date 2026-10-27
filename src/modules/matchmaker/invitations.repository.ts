import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  campaignInvitations,
  campaigns,
  creators,
  products,
  sellers,
  type CampaignInvitation,
  type InvitationStatus,
} from '../../db/schema.js';

export type NewInvitation = Omit<typeof campaignInvitations.$inferInsert, 'id' | 'createdAt' | 'status' | 'respondedAt'>;

/** An invitation with everything the creator inbox / acceptance needs. */
export interface InvitationDetailRow {
  invitation: CampaignInvitation;
  campaignStatus: string;
  commissionRate: string;
  productId: string;
  productName: string;
  productStatus: string;
  price: string;
  currency: string;
  category: string;
  brandName: string;
  sellerStatus: string;
}

const detailColumns = {
  invitation: campaignInvitations,
  campaignStatus: campaigns.status,
  commissionRate: campaigns.commissionRate,
  productId: products.id,
  productName: products.name,
  productStatus: products.status,
  price: products.price,
  currency: products.currency,
  category: products.category,
  brandName: sellers.name,
  sellerStatus: sellers.status,
};

export class InvitationsRepository {
  constructor(private readonly db: Database) {}

  private details() {
    return this.db
      .select(detailColumns)
      .from(campaignInvitations)
      .innerJoin(campaigns, eq(campaigns.id, campaignInvitations.campaignId))
      .innerJoin(products, eq(products.id, campaigns.productId))
      .innerJoin(sellers, eq(sellers.id, campaignInvitations.sellerId))
      .$dynamic();
  }

  // ---------- Quotas ----------

  /** Serializes invitation sends per seller (row lock held until the transaction ends). */
  async lockSeller(sellerId: string): Promise<void> {
    await this.db.select({ id: sellers.id }).from(sellers).where(eq(sellers.id, sellerId)).for('update');
  }

  /** Pending invitations still inside their window (an expired one frees its slot immediately). */
  async countActivePending(campaignId: string, now: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(campaignInvitations)
      .where(
        and(
          eq(campaignInvitations.campaignId, campaignId),
          eq(campaignInvitations.status, 'pending'),
          gt(campaignInvitations.expiresAt, now),
        ),
      );
    return row?.n ?? 0;
  }

  /** Invitations this seller sent (or re-sent) after `since`, and the oldest such send. */
  async sendsSince(sellerId: string, since: Date): Promise<{ count: number; oldest: Date | null }> {
    const [row] = await this.db
      .select({
        count: sql<number>`COUNT(*)::int`,
        oldest: sql<Date | null>`MIN(${campaignInvitations.sentAt})`.mapWith((v: string | Date | null) =>
          v === null ? null : new Date(v),
        ),
      })
      .from(campaignInvitations)
      .where(and(eq(campaignInvitations.sellerId, sellerId), gt(campaignInvitations.sentAt, since)));
    return { count: row?.count ?? 0, oldest: row?.oldest ?? null };
  }

  async findByCampaignAndCreator(campaignId: string, creatorId: string): Promise<CampaignInvitation | null> {
    const [row] = await this.db
      .select()
      .from(campaignInvitations)
      .where(and(eq(campaignInvitations.campaignId, campaignId), eq(campaignInvitations.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  }

  async insert(values: NewInvitation): Promise<CampaignInvitation> {
    const [row] = await this.db.insert(campaignInvitations).values(values).returning();
    if (!row) throw new Error('Insert into campaign_invitations returned no row');
    return row;
  }

  /** Re-sends an expired invitation (same row: one invitation per campaign + creator). */
  async reopen(
    id: string,
    values: Pick<NewInvitation, 'matchScore' | 'matchReason' | 'customNote' | 'expiresAt' | 'sentAt'>,
  ): Promise<CampaignInvitation> {
    const [row] = await this.db
      .update(campaignInvitations)
      .set({ ...values, status: 'pending', respondedAt: null })
      .where(eq(campaignInvitations.id, id))
      .returning();
    if (!row) throw new Error('Reopen of campaign_invitations returned no row');
    return row;
  }

  /** Transitions only from `pending`, so concurrent responses can't overwrite each other. */
  async respond(id: string, status: Exclude<InvitationStatus, 'pending'>, at: Date): Promise<CampaignInvitation | null> {
    const [row] = await this.db
      .update(campaignInvitations)
      .set({ status, respondedAt: status === 'expired' ? null : at })
      .where(and(eq(campaignInvitations.id, id), eq(campaignInvitations.status, 'pending')))
      .returning();
    return row ?? null;
  }

  async listForCampaign(campaignId: string) {
    return this.db
      .select({ invitation: campaignInvitations, creatorSlug: creators.slug, creatorName: creators.name, creatorHandle: creators.handle })
      .from(campaignInvitations)
      .innerJoin(creators, eq(creators.id, campaignInvitations.creatorId))
      .where(eq(campaignInvitations.campaignId, campaignId))
      .orderBy(desc(campaignInvitations.createdAt), desc(campaignInvitations.id));
  }

  /** Map of creator id → invitation, for annotating matchmaker results. */
  async byCreatorForCampaign(campaignId: string): Promise<Map<string, CampaignInvitation>> {
    const rows = await this.db.select().from(campaignInvitations).where(eq(campaignInvitations.campaignId, campaignId));
    return new Map(rows.map((r) => [r.creatorId, r]));
  }

  async listForCreator(creatorId: string): Promise<InvitationDetailRow[]> {
    return this.details()
      .where(eq(campaignInvitations.creatorId, creatorId))
      .orderBy(desc(campaignInvitations.createdAt), desc(campaignInvitations.id));
  }

  /** Scoped to the creator: another creator's invitation is indistinguishable from a missing one. */
  async findForCreator(invitationId: string, creatorId: string): Promise<InvitationDetailRow | null> {
    const [row] = await this.details()
      .where(and(eq(campaignInvitations.id, invitationId), eq(campaignInvitations.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  }
}
