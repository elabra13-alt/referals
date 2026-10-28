import { and, count, countDistinct, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { campaigns, codes, links, products, sales, sellers, type Campaign, type Product } from '../../db/schema.js';
import { centsToDecimal, decimalToCents } from '../../lib/money.js';

/**
 * Read model for the seller dashboard. Every query filters on the signed-in
 * seller inside the SQL itself (sales.seller_id, or products.seller_id through
 * the campaign → product chain), so no other tenant's numbers can leak in.
 */

export interface DashboardSeller {
  id: string;
  name: string;
  status: string;
  apiKeyHash: string | null;
  /** Shopify shop domain, else the host of the newest product's checkout URL. */
  storeDomain: string | null;
  /** Buyer discount percent on Shopify-provisioned codes, e.g. "10.00"; null without Shopify. */
  buyerDiscountPercent: string | null;
}

export interface DashboardKpis {
  /** Net total of attributed, non-refunded sales, decimal MXN string. */
  gmv: string;
  /** Distinct creators with an active link on an active campaign. */
  activeCreators: number;
  /** Single-use codes applied at checkout. */
  redeemedCoupons: number;
}

export interface DashboardCampaign {
  campaign: Campaign;
  product: Pick<Product, 'id' | 'name' | 'imageUrl' | 'price' | 'currency' | 'status' | 'category'>;
}

export class SellerDashboardService {
  constructor(private readonly db: Database) {}

  async findSeller(sellerId: string): Promise<DashboardSeller | null> {
    const [seller] = await this.db.select().from(sellers).where(eq(sellers.id, sellerId)).limit(1);
    if (!seller) return null;
    let storeDomain = seller.shopifyShopDomain;
    if (!storeDomain) {
      const [latest] = await this.db
        .select({ url: products.checkoutBaseUrl })
        .from(products)
        .where(eq(products.sellerId, sellerId))
        .orderBy(desc(products.createdAt))
        .limit(1);
      storeDomain = latest ? new URL(latest.url).hostname : null;
    }
    return {
      id: seller.id,
      name: seller.name,
      status: seller.status,
      apiKeyHash: seller.apiKeyHash,
      storeDomain,
      buyerDiscountPercent: seller.shopifyDiscountPercentage,
    };
  }

  async kpis(sellerId: string): Promise<DashboardKpis> {
    const ownCampaign = eq(products.sellerId, sellerId);
    const [[gmv], [creators], [redeemed]] = await Promise.all([
      this.db
        .select({ total: sql<string>`coalesce(sum(${sales.netTotal}), 0)::text` })
        .from(sales)
        .where(and(eq(sales.sellerId, sellerId), eq(sales.attributed, true), eq(sales.status, 'paid'))),
      this.db
        .select({ n: countDistinct(links.influencerSlug) })
        .from(links)
        .innerJoin(campaigns, eq(campaigns.id, links.campaignId))
        .innerJoin(products, eq(products.id, campaigns.productId))
        .where(and(ownCampaign, eq(links.status, 'active'), eq(campaigns.status, 'active'))),
      this.db
        .select({ n: count() })
        .from(codes)
        .innerJoin(links, eq(links.id, codes.linkId))
        .innerJoin(campaigns, eq(campaigns.id, links.campaignId))
        .innerJoin(products, eq(products.id, campaigns.productId))
        .where(and(ownCampaign, eq(codes.status, 'applied'))),
    ]);
    return {
      gmv: centsToDecimal(decimalToCents(gmv?.total ?? '0')),
      activeCreators: Number(creators?.n ?? 0),
      redeemedCoupons: Number(redeemed?.n ?? 0),
    };
  }

  /** Newest first; ended campaigns are left out (nothing to manage there). */
  async campaigns(sellerId: string, limit = 50): Promise<DashboardCampaign[]> {
    const rows = await this.db
      .select({
        campaign: campaigns,
        product: {
          id: products.id,
          name: products.name,
          imageUrl: products.imageUrl,
          price: products.price,
          currency: products.currency,
          status: products.status,
          category: products.category,
        },
      })
      .from(campaigns)
      .innerJoin(products, eq(products.id, campaigns.productId))
      .where(and(eq(products.sellerId, sellerId), sql`${campaigns.status} <> 'ended'`))
      .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
      .limit(limit);
    return rows;
  }

  /** Products a new campaign can be launched for. */
  async activeProducts(sellerId: string): Promise<Pick<Product, 'id' | 'name'>[]> {
    return this.db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(eq(products.sellerId, sellerId), eq(products.status, 'active')))
      .orderBy(desc(products.createdAt))
      .limit(100);
  }
}
