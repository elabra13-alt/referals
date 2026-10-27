import { z } from 'zod';

/** Creator slugs are stored uppercase; URLs may use any case. */
export const StorefrontSlugParamsSchema = z.object({
  slug: z
    .string()
    .regex(/^[A-Za-z0-9]{3,16}$/)
    .transform((s) => s.toUpperCase()),
});

export const StorefrontCouponParamsSchema = StorefrontSlugParamsSchema.extend({ productId: z.uuid() });

const HookText = z
  .string()
  .trim()
  .max(280)
  .transform((v) => v || null);

/** Creator adds (or re-configures) a product card from one of their own referral links. */
export const UpsertStorefrontItemSchema = z
  .object({
    link_id: z.uuid(),
    display_order: z.number().int().min(0).max(1000).default(0),
    is_featured: z.boolean().default(false),
    custom_hook_text: HookText.nullish().transform((v) => v ?? null),
    is_active: z.boolean().default(true),
  })
  .strict();

export const UpdateStorefrontItemSchema = z
  .object({
    display_order: z.number().int().min(0).max(1000).optional(),
    is_featured: z.boolean().optional(),
    custom_hook_text: HookText.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field to update');

export const ItemIdParamsSchema = z.object({ id: z.uuid() });

export type UpsertStorefrontItemInput = z.output<typeof UpsertStorefrontItemSchema>;
export type UpdateStorefrontItemInput = z.output<typeof UpdateStorefrontItemSchema>;

// ---------- Responses ----------

/** Public, buyer-facing creator profile. No email, banking data or internal ids. */
export interface StorefrontCreatorDto {
  slug: string;
  name: string;
  handle: string;
  bio: string | null;
  avatar_url: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  is_verified: boolean;
}

export interface StorefrontProductDto {
  product_id: string;
  name: string;
  image_url: string | null;
  price: string;
  currency: string;
  category: string;
  hook: string | null;
  is_featured: boolean;
  /** Fallback buyer page for this product (works without JavaScript). */
  link_slug: string;
}

export interface StorefrontDto {
  creator: StorefrontCreatorDto;
  products: StorefrontProductDto[];
}

/** Creator-facing view of an item, including inactive ones. */
export interface StorefrontItemDto {
  id: string;
  product_id: string;
  product_name: string;
  product_image_url: string | null;
  category: string;
  /** The creator's own commission on this product (never shown to buyers). */
  commission_rate: string;
  campaign_id: string;
  link_id: string;
  link_slug: string;
  display_order: number;
  is_featured: boolean;
  custom_hook_text: string | null;
  is_active: boolean;
  /** Whether buyers can currently see it (active item + live link, campaign and product). */
  is_live: boolean;
  created_at: string;
}
