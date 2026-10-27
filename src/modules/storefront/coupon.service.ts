import { AppError } from '../../lib/errors.js';
import type { CodeIssuanceService, CodeRequestOutcome } from '../codes/code-issuance.service.js';
import { CodeRequestBodySchema } from '../codes/codes.schemas.js';
import { parseOrThrow } from '../../lib/validation.js';
import { assessLinkAvailability, linkInactiveError } from '../links/link-availability.js';
import type { Creator } from '../../db/schema.js';
import type { CreatorStorefrontItem } from '../../db/schema/storefront.js';
import type { StorefrontItemRow, StorefrontRepository } from './storefront.repository.js';
import type {
  StorefrontDto,
  StorefrontItemDto,
  UpdateStorefrontItemInput,
  UpsertStorefrontItemInput,
} from './storefront.schemas.js';

const storefrontNotFound = () => new AppError(404, 'STOREFRONT_NOT_FOUND', 'This storefront does not exist.');
const productNotInStorefront = () =>
  new AppError(404, 'PRODUCT_NOT_IN_STOREFRONT', 'This product is not available in this storefront.');
const itemNotFound = () => new AppError(404, 'STOREFRONT_ITEM_NOT_FOUND', 'Storefront item not found.');

export type StorefrontCouponOutcome = CodeRequestOutcome & { productId: string; creatorSlug: string };

/**
 * Creator storefronts (/c/:slug) and their coupon requests.
 *
 * There is deliberately no second coupon generator here: a storefront coupon is
 * issued by the same CodeIssuanceService as link-page coupons, against the
 * item's backing link. That keeps one source of truth for the
 * REF-[CREATOR]-[ENTROPY] format (Modified Crockford Base32 entropy, 48h expiry,
 * status `issued`), the anti-fraud shield (IP sliding window, disposable email,
 * 24h one-code-per-buyer), Shopify provisioning, and webhook attribution.
 */
export class StorefrontService {
  constructor(
    private readonly deps: {
      repo: StorefrontRepository;
      issuance: CodeIssuanceService;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private isLive(row: StorefrontItemRow): boolean {
    return row.item.isActive && assessLinkAvailability(row, this.now()) === 'active';
  }

  private async activeCreator(slug: string): Promise<Creator> {
    const creator = await this.deps.repo.findCreatorBySlug(slug);
    if (!creator || creator.status !== 'active') throw storefrontNotFound();
    return creator;
  }

  // ---------- Public ----------

  async getStorefront(slug: string): Promise<StorefrontDto> {
    const creator = await this.activeCreator(slug);
    const rows = (await this.deps.repo.listItems(creator.id)).filter((r) => this.isLive(r));
    return {
      creator: {
        slug: creator.slug,
        name: creator.name,
        handle: creator.handle,
        bio: creator.bio,
        avatar_url: creator.avatarUrl,
        instagram_handle: creator.instagramHandle,
        tiktok_handle: creator.tiktokHandle,
        is_verified: creator.isVerified,
      },
      products: rows.map((r) => ({
        product_id: r.item.productId,
        name: r.productName,
        price: r.price,
        currency: r.currency,
        category: r.category,
        hook: r.item.customHookText,
        is_featured: r.item.isFeatured,
        link_slug: r.linkSlug,
      })),
    };
  }

  /**
   * Issues a single-use coupon for one storefront product. The caller must have
   * enforced the IP rate limit already (as on /v1/codes/request).
   */
  async requestCoupon(slug: string, productId: string, body: unknown): Promise<StorefrontCouponOutcome> {
    const creator = await this.activeCreator(slug);
    const row = await this.deps.repo.findItemByProduct(creator.id, productId);
    if (!row || !row.item.isActive) throw productNotInStorefront();
    const availability = assessLinkAvailability(row, this.now());
    if (availability !== 'active') throw linkInactiveError(availability);

    // Same validation/normalization as link-page requests; the link comes from the item, never the client.
    const input = parseOrThrow(
      CodeRequestBodySchema,
      { ...(typeof body === 'object' && body !== null ? body : {}), link_slug: row.linkSlug },
      'Invalid request.',
    );
    const outcome = await this.deps.issuance.requestCode(input);
    return { ...outcome, productId, creatorSlug: creator.slug };
  }

  // ---------- Creator self-service ----------

  private toItemDto(row: StorefrontItemRow): StorefrontItemDto {
    return {
      id: row.item.id,
      product_id: row.item.productId,
      product_name: row.productName,
      campaign_id: row.item.campaignId,
      link_id: row.item.linkId,
      link_slug: row.linkSlug,
      display_order: row.item.displayOrder,
      is_featured: row.item.isFeatured,
      custom_hook_text: row.item.customHookText,
      is_active: row.item.isActive,
      is_live: this.isLive(row),
      created_at: row.item.createdAt.toISOString(),
    };
  }

  async listMyItems(creator: Creator): Promise<{ creator_slug: string; items: StorefrontItemDto[] }> {
    const rows = await this.deps.repo.listItems(creator.id);
    return { creator_slug: creator.slug, items: rows.map((r) => this.toItemDto(r)) };
  }

  /** Adds a product card from one of the creator's own links, or re-configures the existing card for that product. */
  async upsertMyItem(creator: Creator, input: UpsertStorefrontItemInput): Promise<{ created: boolean; item: StorefrontItemDto }> {
    const link = await this.deps.repo.findOwnedLink(creator, input.link_id);
    if (!link) throw new AppError(404, 'LINK_NOT_FOUND', 'Link not found.');

    const existing = await this.deps.repo.findItemByProduct(creator.id, link.productId);
    await this.deps.repo.upsertItem({
      creatorId: creator.id,
      productId: link.productId,
      campaignId: link.campaignId,
      linkId: link.linkId,
      displayOrder: input.display_order,
      isFeatured: input.is_featured,
      customHookText: input.custom_hook_text,
      isActive: input.is_active,
    });
    const row = await this.deps.repo.findItemByProduct(creator.id, link.productId);
    return { created: !existing, item: this.toItemDto(row!) };
  }

  async updateMyItem(creator: Creator, itemId: string, input: UpdateStorefrontItemInput): Promise<StorefrontItemDto> {
    const patch: Partial<CreatorStorefrontItem> = {};
    if (input.display_order !== undefined) patch.displayOrder = input.display_order;
    if (input.is_featured !== undefined) patch.isFeatured = input.is_featured;
    if (input.custom_hook_text !== undefined) patch.customHookText = input.custom_hook_text;
    if (input.is_active !== undefined) patch.isActive = input.is_active;
    const updated = await this.deps.repo.updateItem(creator.id, itemId, patch);
    if (!updated) throw itemNotFound();
    const row = await this.deps.repo.findItemByProduct(creator.id, updated.productId);
    return this.toItemDto(row!);
  }

  async deleteMyItem(creator: Creator, itemId: string): Promise<void> {
    if (!(await this.deps.repo.deleteItem(creator.id, itemId))) throw itemNotFound();
  }
}
