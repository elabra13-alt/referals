import { and, asc, desc, eq, or } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { campaigns, creators, links, products, type Creator } from '../../db/schema.js';
import { creatorStorefrontItems, type CreatorStorefrontItem } from '../../db/schema/storefront.js';

/** An item joined with everything needed to render it and to judge whether it is live. */
export interface StorefrontItemRow {
  item: CreatorStorefrontItem;
  linkSlug: string;
  linkStatus: string;
  linkExpiresAt: Date | null;
  campaignStatus: string;
  productStatus: string;
  productName: string;
  price: string;
  currency: string;
  category: string;
}

export type ItemPatch = Partial<Pick<CreatorStorefrontItem, 'displayOrder' | 'isFeatured' | 'customHookText' | 'isActive'>>;

const itemColumns = {
  item: creatorStorefrontItems,
  linkSlug: links.linkSlug,
  linkStatus: links.status,
  linkExpiresAt: links.expiresAt,
  campaignStatus: campaigns.status,
  productStatus: products.status,
  productName: products.name,
  price: products.price,
  currency: products.currency,
  category: products.category,
};

export class StorefrontRepository {
  constructor(private readonly db: Database) {}

  async findCreatorBySlug(slug: string): Promise<Creator | null> {
    const [row] = await this.db.select().from(creators).where(eq(creators.slug, slug)).limit(1);
    return row ?? null;
  }

  private itemsQuery(creatorId: string) {
    return this.db
      .select(itemColumns)
      .from(creatorStorefrontItems)
      .innerJoin(links, eq(links.id, creatorStorefrontItems.linkId))
      .innerJoin(campaigns, eq(campaigns.id, creatorStorefrontItems.campaignId))
      .innerJoin(products, eq(products.id, creatorStorefrontItems.productId))
      .where(eq(creatorStorefrontItems.creatorId, creatorId))
      .$dynamic();
  }

  /** Every item (active or not), featured first, then by display order. */
  async listItems(creatorId: string): Promise<StorefrontItemRow[]> {
    return this.itemsQuery(creatorId).orderBy(
      desc(creatorStorefrontItems.isFeatured),
      asc(creatorStorefrontItems.displayOrder),
      asc(creatorStorefrontItems.createdAt),
    );
  }

  async findItemByProduct(creatorId: string, productId: string): Promise<StorefrontItemRow | null> {
    const [row] = await this.db
      .select(itemColumns)
      .from(creatorStorefrontItems)
      .innerJoin(links, eq(links.id, creatorStorefrontItems.linkId))
      .innerJoin(campaigns, eq(campaigns.id, creatorStorefrontItems.campaignId))
      .innerJoin(products, eq(products.id, creatorStorefrontItems.productId))
      .where(and(eq(creatorStorefrontItems.creatorId, creatorId), eq(creatorStorefrontItems.productId, productId)))
      .limit(1);
    return row ?? null;
  }

  async findItem(creatorId: string, itemId: string): Promise<CreatorStorefrontItem | null> {
    const [row] = await this.db
      .select()
      .from(creatorStorefrontItems)
      .where(and(eq(creatorStorefrontItems.id, itemId), eq(creatorStorefrontItems.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The creator's own link (by creator_id, or influencer_slug for links that
   * predate creator profiles) together with the product it promotes.
   */
  async findOwnedLink(creator: Pick<Creator, 'id' | 'slug'>, linkId: string) {
    const [row] = await this.db
      .select({ linkId: links.id, campaignId: campaigns.id, productId: campaigns.productId })
      .from(links)
      .innerJoin(campaigns, eq(campaigns.id, links.campaignId))
      .where(and(eq(links.id, linkId), or(eq(links.creatorId, creator.id), eq(links.influencerSlug, creator.slug))))
      .limit(1);
    return row ?? null;
  }

  /** Insert or update by (creator, product): one storefront card per product. */
  async upsertItem(values: {
    creatorId: string;
    productId: string;
    campaignId: string;
    linkId: string;
    displayOrder: number;
    isFeatured: boolean;
    customHookText: string | null;
    isActive: boolean;
  }): Promise<CreatorStorefrontItem> {
    const { creatorId: _c, productId: _p, ...updatable } = values;
    const [row] = await this.db
      .insert(creatorStorefrontItems)
      .values(values)
      .onConflictDoUpdate({ target: [creatorStorefrontItems.creatorId, creatorStorefrontItems.productId], set: updatable })
      .returning();
    if (!row) throw new Error('Upsert into creator_storefront_items returned no row');
    return row;
  }

  async updateItem(creatorId: string, itemId: string, patch: ItemPatch): Promise<CreatorStorefrontItem | null> {
    const [row] = await this.db
      .update(creatorStorefrontItems)
      .set(patch)
      .where(and(eq(creatorStorefrontItems.id, itemId), eq(creatorStorefrontItems.creatorId, creatorId)))
      .returning();
    return row ?? null;
  }

  async deleteItem(creatorId: string, itemId: string): Promise<boolean> {
    const rows = await this.db
      .delete(creatorStorefrontItems)
      .where(and(eq(creatorStorefrontItems.id, itemId), eq(creatorStorefrontItems.creatorId, creatorId)))
      .returning({ id: creatorStorefrontItems.id });
    return rows.length > 0;
  }
}
