import { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import RedisMock from 'ioredis-mock';
import type { Database } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import type { ProductStatus } from '../src/db/schema.js';
import { encryptSecret, parseEncryptionKey } from '../src/lib/crypto.js';
import { generateApiKey, generateCreatorApiKey, generateWebhookSecret, hashApiKey } from '../src/lib/keys.js';
import type { RedisClient } from '../src/lib/redis.js';
import { REFERALS_WEBHOOK_TOPICS, type ShopifyClient, type ShopifyCredentials, type SingleUseDiscountInput } from '../src/modules/shopify/shopify.client.js';
import { ShopifyRepository } from '../src/modules/shopify/shopify.repository.js';
import { SHOPIFY_TOKEN_AAD, SHOPIFY_WEBHOOK_SECRET_AAD } from '../src/modules/shopify/shopify.service.js';

/** Migrated data directory, built once per worker and restored for every test. */
let migratedSnapshot: Promise<File | Blob> | undefined;

async function buildMigratedSnapshot(): Promise<File | Blob> {
  const client = new PGlite();
  await migrate(drizzle(client, { schema }), { migrationsFolder: './drizzle' });
  const snapshot = await client.dumpDataDir('none');
  await client.close();
  return snapshot;
}

/** Real Postgres (WASM) with the generated migrations applied; restored from a snapshot, not re-migrated. */
export async function createTestDb(): Promise<{ db: Database; close: () => Promise<void> }> {
  migratedSnapshot ??= buildMigratedSnapshot();
  const client = new PGlite({ loadDataDir: await migratedSnapshot });
  const db = drizzle(client, { schema });
  return { db: db as unknown as Database, close: () => client.close() };
}

let sharedRedis: RedisClient | undefined;

/** One mock per worker (each instance adds listeners to a shared emitter); flushed per test. */
export async function createTestRedis(): Promise<RedisClient> {
  sharedRedis ??= new RedisMock() as unknown as RedisClient;
  await sharedRedis.flushall();
  return sharedRedis;
}

export class TestClock {
  constructor(private ms = Date.parse('2026-10-13T15:00:00.000Z')) {}
  now = (): Date => new Date(this.ms);
  nowMs = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface SeedOptions {
  linkSlug?: string;
  influencerSlug?: string;
  checkoutBaseUrl?: string;
  linkStatus?: string;
  productStatus?: ProductStatus;
  linkExpiresAt?: Date | null;
  category?: string;
  commissionRate?: string;
  /** Reuse an existing seller instead of creating one. */
  sellerId?: string;
}

export const TEST_WEBHOOK_SECRET = 'whsec_test_secret';
export const TEST_ENCRYPTION_KEY = parseEncryptionKey('a'.repeat(64));

/** Stores the secret AES-256-GCM encrypted, as production does (pass `plaintext` to simulate legacy rows). */
export async function seedSeller(db: Database, secret = TEST_WEBHOOK_SECRET, opts: { plaintext?: boolean } = {}) {
  const webhookSecret = opts.plaintext ? secret : encryptSecret(secret, TEST_ENCRYPTION_KEY);
  const [seller] = await db.insert(schema.sellers).values({ name: 'Glow Shop', webhookSecret }).returning();
  return seller!;
}

/** Seeds a creator with a working `cr_live_` key; returns the row plus the plaintext key and auth headers. */
export async function seedCreator(db: Database, overrides: Partial<typeof schema.creators.$inferInsert> = {}) {
  const slug = overrides.slug ?? 'LEO';
  const apiKey = generateCreatorApiKey();
  const [creator] = await db
    .insert(schema.creators)
    .values({
      slug,
      handle: `@${slug.toLowerCase()}`,
      name: `Creator ${slug}`,
      email: `${slug.toLowerCase()}@creators.mx`,
      niche: 'beauty',
      followersCount: 25_000,
      engagementRate: '0.0500',
      speiClabe: '002010077777777771',
      apiKeyHash: hashApiKey(apiKey),
      ...overrides,
    })
    .returning();
  return { ...creator!, apiKey, authHeaders: { authorization: `Bearer ${apiKey}` } };
}

/** Seeds a seller with a working API key; returns the plaintext credentials alongside the row. */
export async function seedAuthenticatedSeller(db: Database, name = 'Glow Shop') {
  const apiKey = generateApiKey();
  const webhookSecret = generateWebhookSecret();
  const [seller] = await db
    .insert(schema.sellers)
    .values({ name, apiKeyHash: hashApiKey(apiKey), webhookSecret: encryptSecret(webhookSecret, TEST_ENCRYPTION_KEY) })
    .returning();
  return { seller: seller!, apiKey, webhookSecret, authHeaders: { authorization: `Bearer ${apiKey}` } };
}

export async function seedLink(db: Database, opts: SeedOptions = {}) {
  const sellerId = opts.sellerId ?? (await seedSeller(db)).id;
  const [product] = await db
    .insert(schema.products)
    .values({
      sellerId,
      name: 'Glow Serum',
      price: '499.00',
      margin: '150.00',
      checkoutBaseUrl: opts.checkoutBaseUrl ?? 'https://shop.example.mx/checkout',
      category: opts.category ?? 'beauty',
      escrowDays: 14,
      status: opts.productStatus ?? 'active',
    })
    .returning();
  const [campaign] = await db.insert(schema.campaigns).values({ productId: product!.id, commissionRate: opts.commissionRate ?? '0.1500' }).returning();
  const [link] = await db
    .insert(schema.links)
    .values({
      campaignId: campaign!.id,
      influencerSlug: opts.influencerSlug ?? 'leo',
      linkSlug: opts.linkSlug ?? 'leo-glow-serum',
      status: opts.linkStatus ?? 'active',
      expiresAt: opts.linkExpiresAt ?? null,
    })
    .returning();
  return { product: product!, campaign: campaign!, link: link! };
}

// ---------- Shopify ----------

/** Records Admin API calls; set `failWith` / `getShopError` / `webhookError` to simulate Shopify failures. */
export class MockShopifyClient implements ShopifyClient {
  discounts: { creds: ShopifyCredentials; input: SingleUseDiscountInput }[] = [];
  webhookRegistrations: { creds: ShopifyCredentials; callbackUrl: string }[] = [];
  failWith: Error | null = null;
  getShopError: Error | null = null;
  webhookError: Error | null = null;
  /** Overrides the domain getShop reports (simulates a token for a different shop). */
  reportedDomain: string | null = null;

  async getShop(creds: ShopifyCredentials) {
    if (this.getShopError) throw this.getShopError;
    return { name: 'Glow Shop MX', myshopifyDomain: this.reportedDomain ?? creds.shopDomain };
  }

  async createSingleUseDiscount(creds: ShopifyCredentials, input: SingleUseDiscountInput) {
    if (this.failWith) throw this.failWith;
    this.discounts.push({ creds, input });
    return { id: `gid://shopify/DiscountCodeNode/${this.discounts.length}` };
  }

  async registerWebhooks(creds: ShopifyCredentials, callbackUrl: string) {
    if (this.webhookError) throw this.webhookError;
    this.webhookRegistrations.push({ creds, callbackUrl });
    return REFERALS_WEBHOOK_TOPICS.map((t) => `gid://shopify/WebhookSubscription/${t}`);
  }
}

export const TEST_SHOPIFY = {
  shopDomain: 'glow-shop.myshopify.com',
  // Not hex: must not look like a real token to secret scanners, but still passes ShopifySetupSchema.
  accessToken: 'shpat_MockTestToken000000000000000000000',
  webhookSecret: 'shopify_app_secret_0123456789',
};

/** A seller with an API key and a connected (encrypted) Shopify store. */
export async function seedShopifySeller(db: Database, overrides: Partial<typeof TEST_SHOPIFY> & { discountPercentage?: string } = {}) {
  const auth = await seedAuthenticatedSeller(db);
  const shopify = { ...TEST_SHOPIFY, ...overrides };
  await new ShopifyRepository(db).save(auth.seller.id, {
    shopDomain: shopify.shopDomain,
    encryptedAccessToken: encryptSecret(shopify.accessToken, TEST_ENCRYPTION_KEY, SHOPIFY_TOKEN_AAD),
    encryptedWebhookSecret: encryptSecret(shopify.webhookSecret, TEST_ENCRYPTION_KEY, SHOPIFY_WEBHOOK_SECRET_AAD),
    discountPercentage: overrides.discountPercentage ?? '10.00',
  });
  return { ...auth, shopify };
}

// ---------- Brand logo assertions (shared by page tests) ----------

/** The official mark's artwork, verbatim from the brand spec. */
/** The flat Kinetic Commercial Nexus mark: Onyx tile, white geometric R, Mint leg (payout). */
export const OFFICIAL_LOGO = {
  parts: [
    '<rect width="40" height="40" rx="10" fill="#0F141C"/>',
    '<path d="M11 9h11.5a7.5 7.5 0 0 1 0 15H16v7h-5V9zm5 5v5h6.5a2.5 2.5 0 0 0 0-5H16z" fill="#FFFFFF"/>',
    '<path d="M19.6 24h5.8l5.6 7h-5.8l-5.6-7z" fill="#10B981"/>',
  ],
};

export function expectOfficialLogo(html: string): void {
  for (const part of OFFICIAL_LOGO.parts) expect(html).toContain(part);
  // Solid fills only: the legacy gradient mark must not come back.
  expect(html).not.toContain('linearGradient');
  expect(html).not.toContain('url(#');
}

/** Every id="…" appears once (duplicate ids are invalid HTML). */
export function expectUniqueIds(html: string): void {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  expect(duplicates).toEqual([]);
}

/** A self-contained data: URI SVG favicon carrying the official mark. */
export function expectSvgFavicon(html: string): void {
  const href = /<link rel="icon" type="image\/svg\+xml" href="(data:image\/svg\+xml,[^"]+)">/.exec(html)?.[1];
  expect(href).toBeDefined();
  const svg = decodeURIComponent(href!.slice('data:image/svg+xml,'.length));
  expect(svg.startsWith('<svg ')).toBe(true);
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expectOfficialLogo(svg);
}
