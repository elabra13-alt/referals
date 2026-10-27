import { z } from 'zod';

// ---------- Seller setup: PATCH /v1/sellers/me/shopify ----------

/** Accepts "Glow-Shop.myshopify.com", "https://glow-shop.myshopify.com/" etc.; stores the bare lowercase host. */
const ShopDomain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/, 'shop_domain must be a *.myshopify.com domain'));

/** Percent off with at most 2 decimals, (0, 100] -> numeric(5,2) string. */
const DiscountPercentage = z
  .number()
  .gt(0)
  .lte(100)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'discount_percentage must have at most 2 decimals')
  .transform((v) => v.toFixed(2));

export const ShopifySetupSchema = z
  .object({
    shop_domain: ShopDomain,
    /** Admin API access token of the seller's custom app (shpat_...). */
    access_token: z.string().trim().regex(/^shp(at|ca|pa)_[A-Za-z0-9]{16,128}$/, 'access_token must be a Shopify Admin API token'),
    /** The app's API secret key, which Shopify uses to sign webhooks. */
    webhook_secret: z.string().trim().min(16).max(256),
    /** Defaults to 10% off. (Zod 4 defaults on a transformed schema take the output value.) */
    discount_percentage: DiscountPercentage.default('10.00'),
  })
  .strict();

export type ShopifySetupInput = z.output<typeof ShopifySetupSchema>;

// ---------- Incoming webhooks (only the fields we use; Shopify sends many more) ----------

/** Shopify money fields are decimal strings, e.g. "1200.00". */
const Money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'expected a decimal amount');
const ShopifyId = z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(String);

export const ShopifyOrderSchema = z.object({
  id: ShopifyId,
  email: z.string().nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  total_line_items_price: Money,
  total_discounts: Money,
  subtotal_price: Money,
  discount_codes: z.array(z.object({ code: z.string() })).default([]),
  processed_at: z.string().nullish(),
  created_at: z.string(),
  customer: z.object({ email: z.string().nullish() }).nullish(),
});

export const ShopifyRefundSchema = z.object({
  id: ShopifyId,
  order_id: ShopifyId,
  created_at: z.string(),
  transactions: z
    .array(z.object({ kind: z.string(), status: z.string().nullish(), amount: Money }))
    .default([]),
});

export type ShopifyOrder = z.output<typeof ShopifyOrderSchema>;
export type ShopifyRefund = z.output<typeof ShopifyRefundSchema>;
