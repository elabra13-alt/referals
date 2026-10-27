import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { campaigns, products, sellers, type Campaign, type Product, type Seller } from '../../db/schema.js';

export type NewProduct = Omit<typeof products.$inferInsert, 'id' | 'sellerId' | 'createdAt'>;
export type ProductPatch = Partial<Omit<NewProduct, 'currency'>>;
export type NewCampaign = Omit<typeof campaigns.$inferInsert, 'id' | 'createdAt' | 'platformFeeRate'>;
export type CampaignPatch = Partial<Pick<Campaign, 'commissionRate' | 'status' | 'isPublicCatalog' | 'requiresVerifiedCreator'>>;

export type AuthSeller = Pick<Seller, 'id' | 'name' | 'status' | 'createdAt'>;

const authSellerColumns = { id: sellers.id, name: sellers.name, status: sellers.status, createdAt: sellers.createdAt };

/**
 * Every product/campaign query takes the authenticated `sellerId` and filters
 * on it inside the SQL itself, so another tenant's rows are unreachable rather
 * than merely checked after the fact.
 */
export class SellersRepository {
  constructor(private readonly db: Database) {}

  // ---------- Sellers ----------

  async createSeller(values: { name: string; apiKeyHash: string; webhookSecret: string }): Promise<AuthSeller> {
    const [row] = await this.db.insert(sellers).values(values).returning(authSellerColumns);
    if (!row) throw new Error('Insert into sellers returned no row');
    return row;
  }

  async findSellerByApiKeyHash(apiKeyHash: string): Promise<AuthSeller | null> {
    const [row] = await this.db.select(authSellerColumns).from(sellers).where(eq(sellers.apiKeyHash, apiKeyHash)).limit(1);
    return row ?? null;
  }

  async setApiKeyHash(sellerId: string, apiKeyHash: string): Promise<void> {
    await this.db.update(sellers).set({ apiKeyHash }).where(eq(sellers.id, sellerId));
  }

  async setWebhookSecret(sellerId: string, encryptedSecret: string): Promise<void> {
    await this.db.update(sellers).set({ webhookSecret: encryptedSecret }).where(eq(sellers.id, sellerId));
  }

  // ---------- Products ----------

  async insertProduct(sellerId: string, values: NewProduct): Promise<Product> {
    const [row] = await this.db
      .insert(products)
      .values({ ...values, sellerId })
      .returning();
    if (!row) throw new Error('Insert into products returned no row');
    return row;
  }

  async findProduct(sellerId: string, productId: string): Promise<Product | null> {
    const [row] = await this.db
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.sellerId, sellerId)))
      .limit(1);
    return row ?? null;
  }

  async listProducts(
    sellerId: string,
    opts: { limit: number; offset: number; status?: Product['status'] | undefined },
  ): Promise<Product[]> {
    const filters: SQL[] = [eq(products.sellerId, sellerId)];
    if (opts.status) filters.push(eq(products.status, opts.status));
    return this.db
      .select()
      .from(products)
      .where(and(...filters))
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  async updateProduct(sellerId: string, productId: string, patch: ProductPatch): Promise<Product | null> {
    const [row] = await this.db
      .update(products)
      .set(patch)
      .where(and(eq(products.id, productId), eq(products.sellerId, sellerId)))
      .returning();
    return row ?? null;
  }

  // ---------- Campaigns (scoped through products.seller_id) ----------

  /** Subquery of the seller's product ids, used to scope campaign reads and writes. */
  private ownedProductIds(sellerId: string) {
    return this.db.select({ id: products.id }).from(products).where(eq(products.sellerId, sellerId));
  }

  async insertCampaign(values: NewCampaign): Promise<Campaign> {
    const [row] = await this.db.insert(campaigns).values(values).returning();
    if (!row) throw new Error('Insert into campaigns returned no row');
    return row;
  }

  async findCampaign(sellerId: string, campaignId: string): Promise<Campaign | null> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), inArray(campaigns.productId, this.ownedProductIds(sellerId))))
      .limit(1);
    return row ?? null;
  }

  async listCampaigns(
    sellerId: string,
    opts: { limit: number; offset: number; productId?: string | undefined; status?: Campaign['status'] | undefined },
  ): Promise<Campaign[]> {
    const filters: SQL[] = [inArray(campaigns.productId, this.ownedProductIds(sellerId))];
    if (opts.productId) filters.push(eq(campaigns.productId, opts.productId));
    if (opts.status) filters.push(eq(campaigns.status, opts.status));
    return this.db
      .select()
      .from(campaigns)
      .where(and(...filters))
      .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
      .limit(opts.limit)
      .offset(opts.offset);
  }

  async updateCampaign(sellerId: string, campaignId: string, patch: CampaignPatch): Promise<Campaign | null> {
    const [row] = await this.db
      .update(campaigns)
      .set(patch)
      .where(and(eq(campaigns.id, campaignId), inArray(campaigns.productId, this.ownedProductIds(sellerId))))
      .returning();
    return row ?? null;
  }
}
