import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { campaigns, creators, links, products } from '../../db/schema.js';

export interface PublicLinkRow {
  linkSlug: string;
  linkStatus: string;
  linkExpiresAt: Date | null;
  influencerSlug: string;
  creatorName: string | null;
  creatorHandle: string | null;
  campaignStatus: string;
  productStatus: string;
  productName: string;
  price: string;
  currency: string;
  category: string;
}

export class LinksRepository {
  constructor(private readonly db: Database) {}

  async findPublicLink(linkSlug: string): Promise<PublicLinkRow | null> {
    const [row] = await this.db
      .select({
        linkSlug: links.linkSlug,
        linkStatus: links.status,
        linkExpiresAt: links.expiresAt,
        influencerSlug: links.influencerSlug,
        creatorName: creators.name,
        creatorHandle: creators.handle,
        campaignStatus: campaigns.status,
        productStatus: products.status,
        productName: products.name,
        price: products.price,
        currency: products.currency,
        category: products.category,
      })
      .from(links)
      .innerJoin(campaigns, eq(campaigns.id, links.campaignId))
      .innerJoin(products, eq(products.id, campaigns.productId))
      .leftJoin(creators, eq(creators.id, links.creatorId))
      .where(eq(links.linkSlug, linkSlug))
      .limit(1);
    return row ?? null;
  }
}
