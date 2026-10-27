import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  unique,
  uniqueIndex,
  varchar,
  char,
} from 'drizzle-orm/pg-core';

export const SELLER_STATUSES = ['active', 'suspended'] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

export const sellers = pgTable(
  'sellers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /**
     * SHA-256 hash of the seller's API key. The UNIQUE constraint's index serves
     * the auth lookup, so no separate index is needed. Null = no key issued yet.
     */
    apiKeyHash: text('api_key_hash').unique(),
    /** AES-256-GCM encrypted HMAC secret for X-Referals-Signature (see lib/crypto.ts). */
    webhookSecret: text('webhook_secret').notNull(),
    /** e.g. "glow-shop.myshopify.com"; identifies the seller on incoming Shopify webhooks. */
    shopifyShopDomain: varchar('shopify_shop_domain', { length: 255 }).unique(),
    /** AES-256-GCM encrypted Admin API access token (shpat_...). */
    shopifyAccessToken: text('shopify_access_token'),
    /** AES-256-GCM encrypted webhook secret used to verify X-Shopify-Hmac-Sha256. */
    shopifyWebhookSecret: text('shopify_webhook_secret'),
    /** Buyer discount (percent off) applied to codes provisioned in Shopify, e.g. 10.00. */
    shopifyDiscountPercentage: numeric('shopify_discount_percentage', { precision: 5, scale: 2 }),
    status: text('status').$type<SellerStatus>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('sellers_status_valid', sql`${t.status} IN ('active', 'suspended')`),
    // A Shopify connection is all-or-nothing: never a domain without credentials.
    check(
      'sellers_shopify_config_complete',
      sql`(${t.shopifyShopDomain} IS NULL AND ${t.shopifyAccessToken} IS NULL AND ${t.shopifyWebhookSecret} IS NULL AND ${t.shopifyDiscountPercentage} IS NULL)
        OR (${t.shopifyShopDomain} IS NOT NULL AND ${t.shopifyAccessToken} IS NOT NULL AND ${t.shopifyWebhookSecret} IS NOT NULL AND ${t.shopifyDiscountPercentage} IS NOT NULL)`,
    ),
    check(
      'sellers_shopify_discount_range',
      sql`${t.shopifyDiscountPercentage} IS NULL OR (${t.shopifyDiscountPercentage} > 0 AND ${t.shopifyDiscountPercentage} <= 100)`,
    ),
  ],
);

export const PRODUCT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const CAMPAIGN_STATUSES = ['active', 'paused', 'ended'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id),
    name: text('name').notNull(),
    price: numeric('price', { precision: 12, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('MXN'),
    margin: numeric('margin', { precision: 12, scale: 2 }).notNull(),
    checkoutBaseUrl: text('checkout_base_url').notNull(),
    category: text('category').notNull(),
    escrowDays: integer('escrow_days').notNull().default(21),
    status: text('status').$type<ProductStatus>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('products_seller_id_idx').on(t.sellerId),
    check('products_price_non_negative', sql`${t.price} >= 0`),
    check('products_escrow_days_positive', sql`${t.escrowDays} > 0`),
    check('products_status_valid', sql`${t.status} IN ('active', 'paused', 'archived')`),
    check('products_margin_non_negative', sql`${t.margin} >= 0`),
  ],
);

/**
 * Not part of the Sprint 1 table list, but `links.campaign_id` needs a parent so a
 * link can be resolved to its product's `checkout_base_url`. Kept intentionally minimal.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    /** Creator commission as a fraction of net_total, e.g. 0.1500 = 15%. */
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull(),
    /** Referals take rate on net_total, charged to the seller on attributed sales. */
    platformFeeRate: numeric('platform_fee_rate', { precision: 5, scale: 4 }).notNull().default('0.0300'),
    status: text('status').$type<CampaignStatus>().notNull().default('active'),
    /** Listed in the creator Open Catalog, where any creator can 1-click join. */
    isPublicCatalog: boolean('is_public_catalog').notNull().default(false),
    /** Only creators the platform has verified (creators.is_verified) may join. */
    requiresVerifiedCreator: boolean('requires_verified_creator').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('campaigns_product_id_idx').on(t.productId),
    // Catalog discovery only ever scans public, active campaigns.
    index('campaigns_public_catalog_idx').on(t.status).where(sql`${t.isPublicCatalog} = true`),
    check('campaigns_status_valid', sql`${t.status} IN ('active', 'paused', 'ended')`),
    check('campaigns_commission_rate_range', sql`${t.commissionRate} > 0 AND ${t.commissionRate} <= 1`),
    check('campaigns_platform_fee_rate_range', sql`${t.platformFeeRate} >= 0 AND ${t.platformFeeRate} < 1`),
  ],
);

export const CREATOR_STATUSES = ['active', 'suspended'] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];
export const CREATOR_NICHES = ['beauty', 'fashion', 'electronics', 'home', 'general'] as const;
export type CreatorNiche = (typeof CREATOR_NICHES)[number];

export const creators = pgTable(
  'creators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Uppercase; equals links.influencer_slug and ledger_entries.influencer_slug. */
    slug: varchar('slug', { length: 16 }).notNull().unique(),
    handle: varchar('handle', { length: 64 }).notNull(),
    name: text('name').notNull(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    /** SHA-256 of the creator's `cr_live_` API key; the UNIQUE index serves auth lookups. Null = no key issued. */
    apiKeyHash: text('api_key_hash').unique(),
    niche: varchar('niche', { length: 32 }).$type<CreatorNiche>().notNull(),
    followersCount: integer('followers_count').notNull().default(0),
    engagementRate: numeric('engagement_rate', { precision: 5, scale: 4 }).notNull().default('0.0300'),
    /** 18-digit Mexican CLABE for SPEI payouts; check digit validated in the API. */
    speiClabe: char('spei_clabe', { length: 18 }),
    status: text('status').$type<CreatorStatus>().notNull().default('active'),
    // ---- Public storefront profile (/c/:slug); all optional ----
    bio: text('bio'),
    /** https only; rendered on the storefront. */
    avatarUrl: text('avatar_url'),
    /** Normalized "@handle". */
    instagramHandle: varchar('instagram_handle', { length: 50 }),
    tiktokHandle: varchar('tiktok_handle', { length: 50 }),
    /** Set by the platform after identity review; never by the creator. */
    isVerified: boolean('is_verified').notNull().default(false),
    /** WhatsApp number, E.164 (e.g. "+525512345678"). Private: never on public DTOs. */
    phone: varchar('phone', { length: 25 }),
    /**
     * When the creator opted in to WhatsApp notifications for `phone`. Business-initiated
     * WhatsApp messages require opt-in, so nothing is sent while this is null. Cleared
     * when the phone number changes.
     */
    whatsappOptInAt: timestamp('whatsapp_opt_in_at', { withTimezone: true }),
    // ---- SPEI payout profile (spei_clabe above is the destination account) ----
    /** Account holder's full legal name, as registered at the bank (SPEI beneficiary). */
    payoutLegalName: text('payout_legal_name'),
    /** Mexican tax ID (RFC): 13 chars for individuals, 12 for companies. Optional. */
    rfc: varchar('rfc', { length: 13 }),
    /** When an existing CLABE was replaced; withdrawals pause for a cooling-off period after it. */
    speiClabeChangedAt: timestamp('spei_clabe_changed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // slug and email lookups use their UNIQUE constraints' indexes.
    index('creators_niche_idx').on(t.niche),
    check('creators_clabe_format', sql`${t.speiClabe} IS NULL OR ${t.speiClabe} ~ '^[0-9]{18}$'`),
    check('creators_status_valid', sql`${t.status} IN ('active', 'suspended')`),
    check('creators_slug_format', sql`${t.slug} ~ '^[A-Z0-9]{3,16}$'`),
    check('creators_followers_non_negative', sql`${t.followersCount} >= 0`),
    check('creators_engagement_rate_range', sql`${t.engagementRate} >= 0 AND ${t.engagementRate} <= 1`),
    check('creators_phone_e164', sql`${t.phone} IS NULL OR ${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`),
    check('creators_whatsapp_opt_in_needs_phone', sql`${t.whatsappOptInAt} IS NULL OR ${t.phone} IS NOT NULL`),
  ],
);

export const links = pgTable(
  'links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    influencerSlug: varchar('influencer_slug', { length: 16 }).notNull(),
    /** Nullable: links created before creators existed only carry influencer_slug. */
    creatorId: uuid('creator_id').references(() => creators.id),
    customScript: text('custom_script'),
    linkSlug: varchar('link_slug', { length: 64 }).notNull().unique(),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('links_campaign_id_idx').on(t.campaignId),
    index('links_influencer_slug_idx').on(t.influencerSlug),
    // One link per creator per campaign.
    uniqueIndex('links_campaign_creator_unique')
      .on(t.campaignId, t.creatorId)
      .where(sql`${t.creatorId} IS NOT NULL`),
  ],
);

export const CODE_STATUSES = ['issued', 'applied', 'expired', 'revoked'] as const;
export type CodeStatus = (typeof CODE_STATUSES)[number];

export const codes = pgTable(
  'codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    linkId: uuid('link_id')
      .notNull()
      .references(() => links.id),
    code: varchar('code', { length: 16 }).notNull().unique(),
    buyerEmail: varchar('buyer_email', { length: 255 }),
    buyerPhone: varchar('buyer_phone', { length: 20 }),
    status: text('status').$type<CodeStatus>().notNull().default('issued'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    autoApplyUrl: text('auto_apply_url').notNull(),
    renewalCount: integer('renewal_count').notNull().default(0),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
  },
  (t) => [
    // Duplicate-guard lookups: (link_id, buyer_phone) / (link_id, buyer_email).
    index('codes_link_id_buyer_phone_idx').on(t.linkId, t.buyerPhone),
    index('codes_link_id_buyer_email_idx').on(t.linkId, t.buyerEmail),
    check('codes_buyer_contact_present', sql`${t.buyerEmail} IS NOT NULL OR ${t.buyerPhone} IS NOT NULL`),
    check(
      'codes_status_valid',
      sql`${t.status} IN ('issued', 'applied', 'expired', 'revoked')`,
    ),
    // Defense in depth for AGENTS.md §5 branded code syntax.
    check('codes_code_format', sql`${t.code} ~ '^REF-[A-Z0-9]{3,5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$'`),
  ],
);

export const SALE_STATUSES = ['paid', 'refunded'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const sales = pgTable(
  'sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id),
    sellerOrderId: varchar('seller_order_id', { length: 128 }).notNull(),
    /** Raw value from the webhook, kept even when it doesn't match a code. */
    appliedDiscountCode: varchar('applied_discount_code', { length: 64 }),
    codeId: uuid('code_id').references(() => codes.id),
    attributed: boolean('attributed').notNull(),
    /** e.g. 'valid_code', 'grace_window', 'code_not_found', 'code_expired', 'code_already_used'. */
    attributionReason: text('attribution_reason').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    grossTotal: numeric('gross_total', { precision: 12, scale: 2 }).notNull(),
    discountTotal: numeric('discount_total', { precision: 12, scale: 2 }).notNull(),
    netTotal: numeric('net_total', { precision: 12, scale: 2 }).notNull(),
    customerEmail: varchar('customer_email', { length: 255 }),
    status: text('status').$type<SaleStatus>().notNull().default('paid'),
    /** Order time used for attribution: min(payload timestamp, received time). */
    orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull(),
    /** Webhook receipt time; escrow is counted from here. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    refundEvent: text('refund_event'),
  },
  (t) => [
    // Order ids are only unique within a seller (two shops can both have order "1001").
    unique('sales_seller_id_seller_order_id_unique').on(t.sellerId, t.sellerOrderId),
    index('sales_code_id_idx').on(t.codeId),
    check('sales_status_valid', sql`${t.status} IN ('paid', 'refunded')`),
    check('sales_totals_non_negative', sql`${t.grossTotal} >= 0 AND ${t.discountTotal} >= 0 AND ${t.netTotal} >= 0`),
  ],
);

export const PAYOUT_STATUSES = ['in_escrow', 'released', 'cancelled', 'clawed_back'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id),
    codeId: uuid('code_id')
      .notNull()
      .references(() => codes.id),
    linkId: uuid('link_id')
      .notNull()
      .references(() => links.id),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Snapshot of campaigns.commission_rate at sale time. */
    commissionRate: numeric('commission_rate', { precision: 5, scale: 4 }).notNull(),
    /** Snapshot of campaigns.platform_fee_rate and the resulting fee owed by the seller. */
    platformFeeRate: numeric('platform_fee_rate', { precision: 5, scale: 4 }).notNull().default('0'),
    platformFeeAmount: numeric('platform_fee_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    escrowDays: integer('escrow_days').notNull(),
    escrowUntil: timestamp('escrow_until', { withTimezone: true }).notNull(),
    status: text('status').$type<PayoutStatus>().notNull().default('in_escrow'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    clawedBackAt: timestamp('clawed_back_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One creator payout per sale: a second insert for the same sale fails.
    unique('payouts_sale_id_unique').on(t.saleId),
    index('payouts_status_escrow_until_idx').on(t.status, t.escrowUntil),
    index('payouts_link_id_idx').on(t.linkId),
    check('payouts_status_valid', sql`${t.status} IN ('in_escrow', 'released', 'cancelled', 'clawed_back')`),
    check('payouts_amount_non_negative', sql`${t.amount} >= 0`),
  ],
);

export const LEDGER_ENTRY_TYPES = ['escrow_release', 'clawback', 'withdrawal_adjustment'] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * Append-only influencer ledger: balance = SUM(amount). Rows are never updated
 * or deleted (enforced by a trigger in migration 0002); corrections are new entries.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    influencerSlug: varchar('influencer_slug', { length: 16 }).notNull(),
    payoutId: uuid('payout_id').references(() => payouts.id),
    entryType: text('entry_type').$type<LedgerEntryType>().notNull(),
    /** Signed: positive for release, negative for clawback. */
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('MXN'),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ledger_influencer_slug_idx').on(t.influencerSlug),
    index('ledger_payout_id_idx').on(t.payoutId),
    check('ledger_entry_type_valid', sql`${t.entryType} IN ('escrow_release', 'clawback', 'withdrawal_adjustment')`),
    check(
      'ledger_amount_sign',
      sql`(${t.entryType} = 'escrow_release' AND ${t.amount} >= 0) OR (${t.entryType} = 'clawback' AND ${t.amount} <= 0) OR ${t.entryType} = 'withdrawal_adjustment'`,
    ),
    // A payout can be released once and clawed back once — guards against double posting.
    uniqueIndex('ledger_payout_entry_type_unique')
      .on(t.payoutId, t.entryType)
      .where(sql`${t.entryType} IN ('escrow_release', 'clawback')`),
  ],
);

export type LedgerEntry = typeof ledgerEntries.$inferSelect;

export const INVITATION_STATUSES = ['pending', 'accepted', 'declined', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * A seller's direct invitation for a creator to promote one campaign. One row per
 * (campaign, creator); an expired invitation can be re-sent (the row is reopened),
 * a declined one cannot. `match_score`/`match_reason` snapshot the matchmaker's
 * view at invite time.
 */
export const campaignInvitations = pgTable(
  'campaign_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 20 }).$type<InvitationStatus>().notNull().default('pending'),
    matchScore: integer('match_score').notNull(),
    matchReason: varchar('match_reason', { length: 255 }).notNull(),
    customNote: varchar('custom_note', { length: 500 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    /** Last time this invitation was sent (first send or re-send); drives the seller's 24h quota. */
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('invitation_campaign_creator_idx').on(t.campaignId, t.creatorId),
    index('invitation_seller_sent_idx').on(t.sellerId, t.sentAt),
    index('invitation_seller_status_idx').on(t.sellerId, t.status),
    index('invitation_creator_status_idx').on(t.creatorId, t.status),
    check('invitation_status_valid', sql`${t.status} IN ('pending', 'accepted', 'declined', 'expired')`),
    check('invitation_match_score_range', sql`${t.matchScore} BETWEEN 0 AND 100`),
  ],
);

export type CampaignInvitation = typeof campaignInvitations.$inferSelect;

export const WITHDRAWAL_STATUSES = ['pending', 'processing', 'paid', 'failed', 'cancelled'] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

/**
 * A creator's SPEI withdrawal. Requesting one debits the ledger immediately
 * (a negative `withdrawal_adjustment` entry, linked here) in the same transaction,
 * so the money can't be spent twice. Destination and beneficiary are snapshotted:
 * editing the payout profile later never redirects an in-flight withdrawal.
 */
export const withdrawalRequests = pgTable(
  'withdrawal_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('MXN'),
    status: varchar('status', { length: 20 }).$type<WithdrawalStatus>().notNull().default('pending'),
    clabe: char('clabe', { length: 18 }).notNull(),
    bankCode: char('bank_code', { length: 3 }).notNull(),
    bankName: text('bank_name'),
    beneficiaryName: text('beneficiary_name').notNull(),
    rfc: varchar('rfc', { length: 13 }),
    /** The ledger debit created with this request. */
    ledgerEntryId: uuid('ledger_entry_id')
      .notNull()
      .references(() => ledgerEntries.id),
    /** Client-supplied Idempotency-Key: a retried request returns the original withdrawal. */
    idempotencyKey: varchar('idempotency_key', { length: 100 }),
    /** SPEI "clave de rastreo", set when the transfer is sent. */
    trackingKey: varchar('tracking_key', { length: 30 }),
    failureReason: text('failure_reason'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    index('withdrawals_creator_requested_idx').on(t.creatorId, t.requestedAt),
    uniqueIndex('withdrawals_creator_idempotency_key_idx').on(t.creatorId, t.idempotencyKey),
    uniqueIndex('withdrawals_ledger_entry_idx').on(t.ledgerEntryId),
    check('withdrawals_status_valid', sql`${t.status} IN ('pending', 'processing', 'paid', 'failed', 'cancelled')`),
    check('withdrawals_amount_positive', sql`${t.amount} > 0`),
    check('withdrawals_clabe_format', sql`${t.clabe} ~ '^[0-9]{18}$'`),
  ],
);

export type WithdrawalRequest = typeof withdrawalRequests.$inferSelect;
export type Seller = typeof sellers.$inferSelect;
export type Sale = typeof sales.$inferSelect;
export type Payout = typeof payouts.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type Link = typeof links.$inferSelect;
export type Creator = typeof creators.$inferSelect;
export type Code = typeof codes.$inferSelect;
export type NewCode = typeof codes.$inferInsert;
