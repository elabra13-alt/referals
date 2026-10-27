import { and, asc, desc, eq, ilike, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { campaigns, links, products, sellers } from '../../db/schema.js';
import { creatorStorefrontItems, type CreatorStorefrontItem } from '../../db/schema/storefront.js';
import { MAPPED_PRODUCT_CATEGORIES, productCategoriesFor, type CatalogCategory } from './hooks-generator.js';

export type OpportunitySort = 'commission' | 'commission_rate' | 'newest';

export interface OpportunityRow {
  campaignId: string;
  commissionRate: string;
  requiresVerifiedCreator: boolean;
  createdAt: Date;
  productId: string;
  productName: string;
  price: string;
  currency: string;
  category: string;
  brandName: string;
  /** The caller's existing link for this campaign, if they already joined. */
  joinedLinkSlug: string | null;
}

/** Only campaigns that are public, active, on an active product of an active seller are discoverable/joinable. */
const isOpen = (): SQL =>
  and(
    eq(campaigns.isPublicCatalog, true),
    eq(campaigns.status, 'active'),
    eq(products.status, 'active'),
    eq(sellers.status, 'active'),
  )!;

/** Escapes LIKE wildcards so a search for "100%" matches literally. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class CatalogRepository {
  constructor(private readonly db: Database) {}

  async listOpportunities(opts: {
    creatorId: string;
    category?: CatalogCategory | undefined;
    q?: string | undefined;
    sort: OpportunitySort;
    limit: number;
    offset: number;
  }): Promise<OpportunityRow[]> {
    const filters: SQL[] = [isOpen()];
    if (opts.category === 'general') {
      filters.push(notInArray(products.category, MAPPED_PRODUCT_CATEGORIES));
    } else if (opts.category) {
      filters.push(inArray(products.category, productCategoriesFor(opts.category)));
    }
    if (opts.q) {
      filters.push(or(ilike(products.name, likePattern(opts.q)), ilike(sellers.name, likePattern(opts.q)))!);
    }

    const order =
      opts.sort === 'commission_rate'
        ? [desc(campaigns.commissionRate)]
        : opts.sort === 'newest'
          ? [desc(campaigns.createdAt)]
          : // Expected creator payout per sale at list price.
            [desc(sql`${products.price} * ${campaigns.commissionRate}`)];

    return this.db
      .select({
        campaignId: campaigns.id,
        commissionRate: campaigns.commissionRate,
        requiresVerifiedCreator: campaigns.requiresVerifiedCreator,
        createdAt: campaigns.createdAt,
        productId: products.id,
        productName: products.name,
        price: products.price,
        currency: products.currency,
        category: products.category,
        brandName: sellers.name,
        joinedLinkSlug: links.linkSlug,
      })
      .from(campaigns)
      .innerJoin(products, eq(products.id, campaigns.productId))
      .innerJoin(sellers, eq(sellers.id, products.sellerId))
      .leftJoin(links, and(eq(links.campaignId, campaigns.id), eq(links.creatorId, opts.creatorId)))
      .where(and(...filters))
      .orderBy(...order, desc(campaigns.createdAt), asc(campaigns.id))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  /** A joinable campaign with its product; null if it does not exist or is not open (anti-enumeration). */
  async findOpenOpportunity(campaignId: string) {
    const [row] = await this.db
      .select({
        campaignId: campaigns.id,
        commissionRate: campaigns.commissionRate,
        requiresVerifiedCreator: campaigns.requiresVerifiedCreator,
        productId: products.id,
        productName: products.name,
        price: products.price,
        currency: products.currency,
        category: products.category,
      })
      .from(campaigns)
      .innerJoin(products, eq(products.id, campaigns.productId))
      .innerJoin(sellers, eq(sellers.id, products.sellerId))
      .where(and(eq(campaigns.id, campaignId), isOpen()))
      .limit(1);
    return row ?? null;
  }

  /**
   * Puts the joined campaign's link on the creator's storefront card for that
   * product: inserts the card, or re-points + re-activates an existing one while
   * keeping the creator's own ordering, featured flag and hook text.
   */
  async attachJoinedLink(values: {
    creatorId: string;
    productId: string;
    campaignId: string;
    linkId: string;
  }): Promise<CreatorStorefrontItem> {
    const [row] = await this.db
      .insert(creatorStorefrontItems)
      .values({ ...values, isActive: true })
      .onConflictDoUpdate({
        target: [creatorStorefrontItems.creatorId, creatorStorefrontItems.productId],
        set: { campaignId: values.campaignId, linkId: values.linkId, isActive: true },
      })
      .returning();
    if (!row) throw new Error('Upsert into creator_storefront_items returned no row');
    return row;
  }
}
