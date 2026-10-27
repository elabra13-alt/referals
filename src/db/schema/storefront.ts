import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { campaigns, creators, links, products } from '../schema.js';

/**
 * A creator's curated public storefront (/c/:slug): one row per product they promote.
 *
 * Every item is backed by the creator's existing referral link for that campaign,
 * so coupons requested from the storefront are ordinary single-use `codes`
 * (REF-[CREATOR]-[ENTROPY], 48h) and flow through the same attribution,
 * escrow, Shopify provisioning and payout pipeline as link-page coupons.
 */
export const creatorStorefrontItems = pgTable(
  'creator_storefront_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    /** The creator's link for this campaign; coupons are issued against it. */
    linkId: uuid('link_id')
      .notNull()
      .references(() => links.id),
    displayOrder: integer('display_order').notNull().default(0),
    isFeatured: boolean('is_featured').notNull().default(false),
    /** AI-generated hook or the creator's personal note, shown on the product card. */
    customHookText: text('custom_hook_text'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('creator_product_unique_idx').on(t.creatorId, t.productId),
    index('storefront_items_creator_order_idx').on(t.creatorId, t.isActive, t.displayOrder),
    check('storefront_items_hook_length', sql`${t.customHookText} IS NULL OR char_length(${t.customHookText}) <= 280`),
  ],
);

export type CreatorStorefrontItem = typeof creatorStorefrontItems.$inferSelect;
export type NewCreatorStorefrontItem = typeof creatorStorefrontItems.$inferInsert;
