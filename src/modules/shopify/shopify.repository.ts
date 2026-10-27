import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { sellers } from '../../db/schema.js';

/** Raw (still encrypted) Shopify columns for one seller. */
export interface StoredShopifyConfig {
  sellerId: string;
  sellerStatus: string;
  shopDomain: string;
  encryptedAccessToken: string;
  encryptedWebhookSecret: string;
  discountPercentage: string;
}

const columns = {
  sellerId: sellers.id,
  sellerStatus: sellers.status,
  shopDomain: sellers.shopifyShopDomain,
  encryptedAccessToken: sellers.shopifyAccessToken,
  encryptedWebhookSecret: sellers.shopifyWebhookSecret,
  discountPercentage: sellers.shopifyDiscountPercentage,
};

type Row = { [K in keyof typeof columns]: string | null };

function toConfig(row: Row | undefined): StoredShopifyConfig | null {
  if (!row?.shopDomain || !row.encryptedAccessToken || !row.encryptedWebhookSecret || !row.discountPercentage) return null;
  return row as StoredShopifyConfig;
}

export class ShopifyRepository {
  constructor(private readonly db: Database) {}

  async findBySellerId(sellerId: string): Promise<StoredShopifyConfig | null> {
    const [row] = await this.db.select(columns).from(sellers).where(eq(sellers.id, sellerId)).limit(1);
    return toConfig(row as Row | undefined);
  }

  async findByShopDomain(shopDomain: string): Promise<StoredShopifyConfig | null> {
    const [row] = await this.db.select(columns).from(sellers).where(eq(sellers.shopifyShopDomain, shopDomain)).limit(1);
    return toConfig(row as Row | undefined);
  }

  async save(
    sellerId: string,
    values: { shopDomain: string; encryptedAccessToken: string; encryptedWebhookSecret: string; discountPercentage: string },
  ): Promise<void> {
    await this.db
      .update(sellers)
      .set({
        shopifyShopDomain: values.shopDomain,
        shopifyAccessToken: values.encryptedAccessToken,
        shopifyWebhookSecret: values.encryptedWebhookSecret,
        shopifyDiscountPercentage: values.discountPercentage,
      })
      .where(eq(sellers.id, sellerId));
  }
}
