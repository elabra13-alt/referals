import { encryptSecret } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { generateApiKey, generateWebhookSecret, hashApiKey } from '../../lib/keys.js';
import { centsToDecimal, decimalToCents } from '../../lib/money.js';
import { escrowDaysForCategory } from '../webhooks/escrow.js';
import type { CampaignPatch, ProductPatch, SellersRepository } from './sellers.repository.js';
import {
  toCampaignDto,
  toProductDto,
  toSellerDto,
  type CampaignDto,
  type CreateCampaignInput,
  type CreateProductInput,
  type ListCampaignsQuery,
  type ListProductsQuery,
  type OnboardSellerInput,
  type ProductDto,
  type SellerDto,
  type UpdateCampaignInput,
  type UpdateProductInput,
} from './sellers.schemas.js';

const productNotFound = () => new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
const campaignNotFound = () => new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');

export interface OnboardingResult {
  seller: SellerDto;
  /** Shown exactly once; only its SHA-256 hash is stored. */
  api_key: string;
  /** Shown exactly once in plaintext; stored AES-256-GCM encrypted. */
  webhook_secret: string;
}

export class SellersService {
  constructor(
    private readonly repo: SellersRepository,
    private readonly encryptionKey: Buffer,
  ) {}

  // ---------- Onboarding & credentials ----------

  async onboard(input: OnboardSellerInput): Promise<OnboardingResult> {
    const apiKey = generateApiKey();
    const webhookSecret = generateWebhookSecret();
    const seller = await this.repo.createSeller({
      name: input.name,
      apiKeyHash: hashApiKey(apiKey),
      webhookSecret: encryptSecret(webhookSecret, this.encryptionKey),
    });
    return { seller: toSellerDto(seller), api_key: apiKey, webhook_secret: webhookSecret };
  }

  /** Invalidates the current key immediately. */
  async rotateApiKey(sellerId: string): Promise<{ api_key: string }> {
    const apiKey = generateApiKey();
    await this.repo.setApiKeyHash(sellerId, hashApiKey(apiKey));
    return { api_key: apiKey };
  }

  /** Webhooks signed with the old secret fail verification from this point on. */
  async rotateWebhookSecret(sellerId: string): Promise<{ webhook_secret: string }> {
    const webhookSecret = generateWebhookSecret();
    await this.repo.setWebhookSecret(sellerId, encryptSecret(webhookSecret, this.encryptionKey));
    return { webhook_secret: webhookSecret };
  }

  // ---------- Products ----------

  async createProduct(sellerId: string, input: CreateProductInput): Promise<ProductDto> {
    const product = await this.repo.insertProduct(sellerId, {
      name: input.name,
      price: centsToDecimal(input.price),
      currency: input.currency,
      margin: centsToDecimal(input.margin),
      checkoutBaseUrl: input.checkout_base_url,
      category: input.category,
      escrowDays: escrowDaysForCategory(input.category),
      status: input.status,
    });
    return toProductDto(product);
  }

  async getProduct(sellerId: string, productId: string): Promise<ProductDto> {
    const product = await this.repo.findProduct(sellerId, productId);
    if (!product) throw productNotFound();
    return toProductDto(product);
  }

  async listProducts(sellerId: string, query: ListProductsQuery): Promise<{ data: ProductDto[]; limit: number; offset: number }> {
    const rows = await this.repo.listProducts(sellerId, query);
    return { data: rows.map(toProductDto), limit: query.limit, offset: query.offset };
  }

  async updateProduct(sellerId: string, productId: string, input: UpdateProductInput): Promise<ProductDto> {
    const current = await this.repo.findProduct(sellerId, productId);
    if (!current) throw productNotFound();
    if (current.status === 'archived') {
      throw new AppError(409, 'PRODUCT_ARCHIVED', 'Archived products cannot be modified.');
    }

    const price = input.price ?? decimalToCents(current.price);
    const margin = input.margin ?? decimalToCents(current.margin);
    if (margin > price) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request.', {
        issues: [{ path: 'margin', message: 'margin cannot exceed price' }],
      });
    }

    const patch: ProductPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.price !== undefined) patch.price = centsToDecimal(input.price);
    if (input.margin !== undefined) patch.margin = centsToDecimal(input.margin);
    if (input.checkout_base_url !== undefined) patch.checkoutBaseUrl = input.checkout_base_url;
    if (input.category !== undefined) {
      patch.category = input.category;
      patch.escrowDays = escrowDaysForCategory(input.category);
    }
    if (input.status !== undefined) patch.status = input.status;

    const updated = await this.repo.updateProduct(sellerId, productId, patch);
    if (!updated) throw productNotFound();
    return toProductDto(updated);
  }

  /**
   * Soft delete: products are referenced by campaigns, codes and sales, so they
   * are archived rather than removed. Archiving stops new codes being issued
   * for the product. Idempotent.
   */
  async archiveProduct(sellerId: string, productId: string): Promise<ProductDto> {
    const current = await this.repo.findProduct(sellerId, productId);
    if (!current) throw productNotFound();
    if (current.status === 'archived') return toProductDto(current);
    const updated = await this.repo.updateProduct(sellerId, productId, { status: 'archived' });
    if (!updated) throw productNotFound();
    return toProductDto(updated);
  }

  // ---------- Campaigns ----------

  async createCampaign(sellerId: string, input: CreateCampaignInput): Promise<CampaignDto> {
    // Ownership check: another seller's product is indistinguishable from a missing one.
    const product = await this.repo.findProduct(sellerId, input.product_id);
    if (!product) throw productNotFound();
    if (product.status !== 'active') {
      throw new AppError(409, 'PRODUCT_NOT_ACTIVE', 'Campaigns can only be created for active products.');
    }
    const campaign = await this.repo.insertCampaign({
      productId: product.id,
      commissionRate: input.commission_rate,
      status: input.status,
      isPublicCatalog: input.is_public_catalog,
      requiresVerifiedCreator: input.requires_verified_creator,
    });
    return toCampaignDto(campaign);
  }

  async getCampaign(sellerId: string, campaignId: string): Promise<CampaignDto> {
    const campaign = await this.repo.findCampaign(sellerId, campaignId);
    if (!campaign) throw campaignNotFound();
    return toCampaignDto(campaign);
  }

  async listCampaigns(sellerId: string, query: ListCampaignsQuery): Promise<{ data: CampaignDto[]; limit: number; offset: number }> {
    const rows = await this.repo.listCampaigns(sellerId, {
      limit: query.limit,
      offset: query.offset,
      productId: query.product_id,
      status: query.status,
    });
    return { data: rows.map(toCampaignDto), limit: query.limit, offset: query.offset };
  }

  /** commission_rate changes apply to future sales only; existing payouts keep their snapshot. */
  async updateCampaign(sellerId: string, campaignId: string, input: UpdateCampaignInput): Promise<CampaignDto> {
    const current = await this.repo.findCampaign(sellerId, campaignId);
    if (!current) throw campaignNotFound();
    if (current.status === 'ended') {
      throw new AppError(409, 'CAMPAIGN_ENDED', 'Ended campaigns cannot be modified.');
    }
    if (input.status === 'active' && current.status !== 'active') {
      const product = await this.repo.findProduct(sellerId, current.productId);
      if (product?.status !== 'active') {
        throw new AppError(409, 'PRODUCT_NOT_ACTIVE', 'Campaigns can only be activated for active products.');
      }
    }

    const patch: CampaignPatch = {};
    if (input.commission_rate !== undefined) patch.commissionRate = input.commission_rate;
    if (input.status !== undefined) patch.status = input.status;
    if (input.is_public_catalog !== undefined) patch.isPublicCatalog = input.is_public_catalog;
    if (input.requires_verified_creator !== undefined) patch.requiresVerifiedCreator = input.requires_verified_creator;

    const updated = await this.repo.updateCampaign(sellerId, campaignId, patch);
    if (!updated) throw campaignNotFound();
    return toCampaignDto(updated);
  }
}
