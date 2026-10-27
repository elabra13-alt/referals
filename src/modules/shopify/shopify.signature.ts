import { createHmac, timingSafeEqual } from 'node:crypto';

export const SHOPIFY_HMAC_HEADER = 'x-shopify-hmac-sha256';
export const SHOPIFY_SHOP_HEADER = 'x-shopify-shop-domain';
export const SHOPIFY_TOPIC_HEADER = 'x-shopify-topic';
export const SHOPIFY_WEBHOOK_ID_HEADER = 'x-shopify-webhook-id';

/** Shopify's format: base64(HMAC-SHA256(secret, rawBody)). */
export function signShopifyPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

/** Constant-time check of the X-Shopify-Hmac-Sha256 header against the raw request bytes. */
export function verifyShopifyHmac(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !/^[A-Za-z0-9+/]+={0,2}$/.test(header.trim())) return false;
  const provided = Buffer.from(header.trim(), 'base64');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
