import { z } from 'zod';
import type { Campaign, Product, Seller } from '../../db/schema.js';
import { zMoneyCents, zRate } from '../../lib/validation.js';

// ---------- Shared ----------

export const IdParamsSchema = z.object({ id: z.uuid() });

const Pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
};

const CheckoutUrl = z
  .string()
  .trim()
  .max(2048)
  .pipe(z.url())
  .refine((v) => new URL(v).protocol === 'https:', 'checkout_base_url must use https');

const Category = z.string().trim().toLowerCase().min(1).max(50);
const Currency = z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 code');

const atLeastOneField = (v: Record<string, unknown>) => Object.values(v).some((x) => x !== undefined);

// ---------- Sellers ----------

export const OnboardSellerSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

// ---------- Products ----------

export const CreateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    price: zMoneyCents,
    currency: Currency.default('MXN'),
    margin: zMoneyCents,
    checkout_base_url: CheckoutUrl,
    category: Category,
    status: z.enum(['active', 'paused']).default('active'),
  })
  .strict()
  .refine((p) => p.margin <= p.price, { path: ['margin'], message: 'margin cannot exceed price' });

/** Currency is immutable: existing sales and payouts are denominated in it. */
export const UpdateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    price: zMoneyCents.optional(),
    margin: zMoneyCents.optional(),
    checkout_base_url: CheckoutUrl.optional(),
    category: Category.optional(),
    status: z.enum(['active', 'paused', 'archived']).optional(),
  })
  .strict()
  .refine(atLeastOneField, 'Provide at least one field to update');

export const ListProductsQuerySchema = z.object({
  ...Pagination,
  status: z.enum(['active', 'paused', 'archived']).optional(),
});

// ---------- Campaigns ----------

/** Strict: platform_fee_rate is set by Referals, never by the seller, so sending it is an error. */
export const CreateCampaignSchema = z
  .object({
    product_id: z.uuid(),
    commission_rate: zRate,
    status: z.enum(['active', 'paused']).default('active'),
    /** List the campaign in the creator Open Catalog (1-click join). */
    is_public_catalog: z.boolean().default(false),
    /** Restrict joining to platform-verified creators. */
    requires_verified_creator: z.boolean().default(false),
  })
  .strict();

export const UpdateCampaignSchema = z
  .object({
    commission_rate: zRate.optional(),
    status: z.enum(['active', 'paused', 'ended']).optional(),
    is_public_catalog: z.boolean().optional(),
    requires_verified_creator: z.boolean().optional(),
  })
  .strict()
  .refine(atLeastOneField, 'Provide at least one field to update');

export const ListCampaignsQuerySchema = z.object({
  ...Pagination,
  product_id: z.uuid().optional(),
  status: z.enum(['active', 'paused', 'ended']).optional(),
});

export type OnboardSellerInput = z.output<typeof OnboardSellerSchema>;
export type CreateProductInput = z.output<typeof CreateProductSchema>;
export type UpdateProductInput = z.output<typeof UpdateProductSchema>;
export type ListProductsQuery = z.output<typeof ListProductsQuerySchema>;
export type CreateCampaignInput = z.output<typeof CreateCampaignSchema>;
export type UpdateCampaignInput = z.output<typeof UpdateCampaignSchema>;
export type ListCampaignsQuery = z.output<typeof ListCampaignsQuerySchema>;

// ---------- Responses ----------

export interface SellerDto {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

export interface ProductDto {
  id: string;
  name: string;
  price: string;
  currency: string;
  margin: string;
  checkout_base_url: string;
  category: string;
  escrow_days: number;
  status: string;
  created_at: string;
}

export interface CampaignDto {
  id: string;
  product_id: string;
  commission_rate: string;
  platform_fee_rate: string;
  status: string;
  is_public_catalog: boolean;
  requires_verified_creator: boolean;
  created_at: string;
}

export const toSellerDto = (s: Pick<Seller, 'id' | 'name' | 'status' | 'createdAt'>): SellerDto => ({
  id: s.id,
  name: s.name,
  status: s.status,
  created_at: s.createdAt.toISOString(),
});

export const toProductDto = (p: Product): ProductDto => ({
  id: p.id,
  name: p.name,
  price: p.price,
  currency: p.currency,
  margin: p.margin,
  checkout_base_url: p.checkoutBaseUrl,
  category: p.category,
  escrow_days: p.escrowDays,
  status: p.status,
  created_at: p.createdAt.toISOString(),
});

export const toCampaignDto = (c: Campaign): CampaignDto => ({
  id: c.id,
  product_id: c.productId,
  commission_rate: c.commissionRate,
  platform_fee_rate: c.platformFeeRate,
  status: c.status,
  is_public_catalog: c.isPublicCatalog,
  requires_verified_creator: c.requiresVerifiedCreator,
  created_at: c.createdAt.toISOString(),
});
