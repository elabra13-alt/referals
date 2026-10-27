import { and, desc, eq, gt, gte, or, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { campaigns, codes, links, products, type Code, type NewCode } from '../../db/schema.js';

export interface LinkContext {
  linkId: string;
  sellerId: string;
  linkStatus: string;
  linkExpiresAt: Date | null;
  influencerSlug: string;
  campaignStatus: string;
  productStatus: string;
  checkoutBaseUrl: string;
}

export interface CodesRepository {
  findLinkContext(linkSlug: string): Promise<LinkContext | null>;
  findActiveCodeForBuyer(params: {
    linkId: string;
    email: string | null;
    phone: string | null;
    issuedSince: Date;
    now: Date;
  }): Promise<Code | null>;
  insertCode(code: NewCode): Promise<Code>;
  revokeCode(codeId: string): Promise<void>;
}

export class DrizzleCodesRepository implements CodesRepository {
  constructor(private readonly db: Database) {}

  async findLinkContext(linkSlug: string): Promise<LinkContext | null> {
    const [row] = await this.db
      .select({
        linkId: links.id,
        sellerId: products.sellerId,
        linkStatus: links.status,
        linkExpiresAt: links.expiresAt,
        influencerSlug: links.influencerSlug,
        campaignStatus: campaigns.status,
        productStatus: products.status,
        checkoutBaseUrl: products.checkoutBaseUrl,
      })
      .from(links)
      .innerJoin(campaigns, eq(campaigns.id, links.campaignId))
      .innerJoin(products, eq(products.id, campaigns.productId))
      .where(eq(links.linkSlug, linkSlug))
      .limit(1);
    return row ?? null;
  }

  async findActiveCodeForBuyer({
    linkId,
    email,
    phone,
    issuedSince,
    now,
  }: Parameters<CodesRepository['findActiveCodeForBuyer']>[0]): Promise<Code | null> {
    const identity: SQL[] = [];
    if (email) identity.push(eq(codes.buyerEmail, email));
    if (phone) identity.push(eq(codes.buyerPhone, phone));
    if (identity.length === 0) return null;

    const [row] = await this.db
      .select()
      .from(codes)
      .where(
        and(
          eq(codes.linkId, linkId),
          or(...identity),
          eq(codes.status, 'issued'),
          gte(codes.issuedAt, issuedSince),
          gt(codes.expiresAt, now),
        ),
      )
      .orderBy(desc(codes.issuedAt))
      .limit(1);
    return row ?? null;
  }

  async insertCode(code: NewCode): Promise<Code> {
    const [row] = await this.db.insert(codes).values(code).returning();
    if (!row) throw new Error('Insert into codes returned no row');
    return row;
  }

  async revokeCode(codeId: string): Promise<void> {
    await this.db.update(codes).set({ status: 'revoked' }).where(eq(codes.id, codeId));
  }
}
