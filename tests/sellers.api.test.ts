import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';
import { links, products, sellers } from '../src/db/schema.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { hashApiKey } from '../src/lib/keys.js';
import { signPayload } from '../src/modules/webhooks/signature.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedAuthenticatedSeller } from './helpers.js';

const ADMIN_TOKEN = 'adm_'.padEnd(40, 'x');

type Auth = { authHeaders: Record<string, string> };

describe('Seller & Catalog Management API', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let alice: Awaited<ReturnType<typeof seedAuthenticatedSeller>>;
  let bob: Awaited<ReturnType<typeof seedAuthenticatedSeller>>;

  /** `null` = no admin token configured. */
  const makeApp = async (adminApiToken: string | null = ADMIN_TOKEN) =>
    buildApp(
      {
        db,
        redis: await createTestRedis(),
        webhookEncryptionKey: TEST_ENCRYPTION_KEY,
        adminApiToken: adminApiToken ?? undefined,
        now: new TestClock().now,
      },
      { logger: false },
    );

  const call = (as: Auth | null, method: InjectOptions['method'], url: string, payload?: object) =>
    app.inject({ method, url, headers: as?.authHeaders ?? {}, ...(payload ? { payload } : {}) });

  const productBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Glow Serum',
    price: 499,
    margin: 150,
    checkout_base_url: 'https://shop.example.mx/checkout',
    category: 'beauty',
    ...overrides,
  });

  const createProduct = async (as: Auth, overrides: Record<string, unknown> = {}) => {
    const res = await call(as, 'POST', '/v1/products', productBody(overrides));
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  const createCampaign = async (as: Auth, productId: string, overrides: Record<string, unknown> = {}) => {
    const res = await call(as, 'POST', '/v1/campaigns', { product_id: productId, commission_rate: 0.15, ...overrides });
    expect(res.statusCode).toBe(201);
    return res.json();
  };

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    app = await makeApp();
    alice = await seedAuthenticatedSeller(db, 'Alice Beauty');
    bob = await seedAuthenticatedSeller(db, 'Bob Gadgets');
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  describe('POST /v1/sellers (onboarding)', () => {
    const onboard = (name = 'Nueva Tienda', token: string | null = ADMIN_TOKEN) =>
      app.inject({
        method: 'POST',
        url: '/v1/sellers',
        headers: token ? { 'x-referals-admin-token': token } : {},
        payload: { name },
      });

    it('creates a seller and returns one-time plaintext credentials', async () => {
      const res = await onboard();
      expect(res.statusCode).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(body.seller).toMatchObject({ name: 'Nueva Tienda', status: 'active' });
      expect(body.api_key).toMatch(/^ref_live_[A-Za-z0-9_-]{43}$/);
      expect(body.webhook_secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

      const [row] = await db.select().from(sellers).where(eq(sellers.id, body.seller.id));
      expect(row!.apiKeyHash).toBe(hashApiKey(body.api_key));
      expect(row!.apiKeyHash).not.toContain(body.api_key);
      expect(row!.webhookSecret).toMatch(/^v1:/);
      expect(decryptSecret(row!.webhookSecret, TEST_ENCRYPTION_KEY)).toBe(body.webhook_secret);
    });

    it('issues credentials that work for the API and for signing webhooks', async () => {
      const { seller, api_key, webhook_secret } = (await onboard()).json();

      const me = await app.inject({ method: 'GET', url: '/v1/seller', headers: { authorization: `Bearer ${api_key}` } });
      expect(me.json()).toMatchObject({ id: seller.id, name: 'Nueva Tienda' });

      const raw = JSON.stringify({
        event: 'order.paid',
        seller_order_id: 'ORD-1',
        applied_discount_code: null,
        currency: 'MXN',
        financials: { gross_total: 100, discount_total: 0, net_total: 100 },
        timestamp: new Date().toISOString(),
      });
      const webhook = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/orders/paid',
        headers: {
          'content-type': 'application/json',
          'x-referals-seller-id': seller.id,
          'x-referals-signature': signPayload(raw, webhook_secret),
        },
        payload: raw,
      });
      expect(webhook.statusCode).toBe(201);
    });

    it('issues unique keys per seller', async () => {
      const a = (await onboard('Tienda A')).json();
      const b = (await onboard('Tienda B')).json();
      expect(a.api_key).not.toBe(b.api_key);
      expect(a.webhook_secret).not.toBe(b.webhook_secret);
    });

    it.each([
      ['missing', null],
      ['wrong', 'adm_'.padEnd(40, 'y')],
    ])('rejects a %s admin token with 401', async (_label, token) => {
      expect((await onboard('X Shop', token)).statusCode).toBe(401);
      expect(await db.select().from(sellers)).toHaveLength(2);
    });

    it('rejects a seller API key in place of the admin token', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/sellers', headers: alice.authHeaders, payload: { name: 'X Shop' } });
      expect(res.statusCode).toBe(401);
    });

    it('is disabled (503) when no admin token is configured', async () => {
      await app.close();
      app = await makeApp(null);
      const res = await onboard();
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('ONBOARDING_DISABLED');
    });

    it('validates the name', async () => {
      expect((await onboard(' ')).statusCode).toBe(400);
    });
  });

  describe('authentication', () => {
    it('accepts Authorization: Bearer and X-Referals-Api-Key', async () => {
      const viaBearer = await app.inject({ method: 'GET', url: '/v1/seller', headers: { authorization: `bearer ${alice.apiKey}` } });
      const viaHeader = await app.inject({ method: 'GET', url: '/v1/seller', headers: { 'x-referals-api-key': alice.apiKey } });
      expect(viaBearer.json().id).toBe(alice.seller.id);
      expect(viaHeader.json().id).toBe(alice.seller.id);
    });

    it.each([
      ['no credentials', {}],
      ['malformed key', { authorization: 'Bearer nope' }],
      ['unknown well-formed key', { authorization: `Bearer ref_live_${'A'.repeat(43)}` }],
      ['non-bearer scheme', { authorization: 'Basic abc' }],
    ])('rejects %s with 401', async (_label, headers) => {
      const res = await app.inject({ method: 'GET', url: '/v1/products', headers });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="referals"');
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    });

    it('rejects suspended sellers with 403', async () => {
      await db.update(sellers).set({ status: 'suspended' }).where(eq(sellers.id, alice.seller.id));
      const res = await call(alice, 'GET', '/v1/products');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('SELLER_SUSPENDED');
    });

    it('rotating the API key invalidates the old one', async () => {
      const { api_key } = (await call(alice, 'POST', '/v1/seller/api-key/rotate')).json();
      expect((await call(alice, 'GET', '/v1/seller')).statusCode).toBe(401);
      const res = await app.inject({ method: 'GET', url: '/v1/seller', headers: { authorization: `Bearer ${api_key}` } });
      expect(res.json().id).toBe(alice.seller.id);
    });

    it('rotating the webhook secret invalidates webhooks signed with the old one', async () => {
      const { webhook_secret } = (await call(alice, 'POST', '/v1/seller/webhook-secret/rotate')).json();
      expect(webhook_secret).not.toBe(alice.webhookSecret);

      const send = (secret: string, orderId: string) => {
        const raw = JSON.stringify({
          event: 'order.paid',
          seller_order_id: orderId,
          currency: 'MXN',
          financials: { gross_total: 10, discount_total: 0, net_total: 10 },
          timestamp: new Date().toISOString(),
        });
        return app.inject({
          method: 'POST',
          url: '/v1/webhooks/orders/paid',
          headers: {
            'content-type': 'application/json',
            'x-referals-seller-id': alice.seller.id,
            'x-referals-signature': signPayload(raw, secret),
          },
          payload: raw,
        });
      };
      expect((await send(alice.webhookSecret, 'ORD-OLD')).statusCode).toBe(401);
      expect((await send(webhook_secret, 'ORD-NEW')).statusCode).toBe(201);
    });
  });

  describe('products', () => {
    it('creates a product with escrow days resolved from its category', async () => {
      const product = await createProduct(alice, { category: ' Fashion ' });
      expect(product).toMatchObject({
        name: 'Glow Serum',
        price: '499.00',
        margin: '150.00',
        currency: 'MXN',
        category: 'fashion',
        escrow_days: 28,
        status: 'active',
      });
      const [row] = await db.select().from(products).where(eq(products.id, product.id));
      expect(row!.sellerId).toBe(alice.seller.id);
    });

    it.each([
      ['beauty', 14],
      ['electronics', 25],
      ['home', 21],
      ['toys', 21],
    ])('resolves %s to %i escrow days', async (category, days) => {
      expect((await createProduct(alice, { category })).escrow_days).toBe(days);
    });

    it.each([
      ['http checkout URL', { checkout_base_url: 'http://shop.example.mx' }],
      ['margin above price', { margin: 600 }],
      ['3-decimal price', { price: 10.005 }],
      ['negative price', { price: -1 }],
      ['seller-supplied escrow_days', { escrow_days: 1 }],
      ['empty name', { name: '' }],
    ])('rejects %s with 400', async (_label, overrides) => {
      const res = await call(alice, 'POST', '/v1/products', productBody(overrides));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('lists only the caller’s products, with pagination and status filter', async () => {
      const a1 = await createProduct(alice, { name: 'A1' });
      const a2 = await createProduct(alice, { name: 'A2', status: 'paused' });
      await createProduct(bob, { name: 'B1' });

      const all = (await call(alice, 'GET', '/v1/products')).json();
      expect(all.data.map((p: { id: string }) => p.id).sort()).toEqual([a1.id, a2.id].sort());

      const page = (await call(alice, 'GET', '/v1/products?limit=1&offset=1')).json();
      expect(page).toMatchObject({ limit: 1, offset: 1 });
      expect(page.data).toHaveLength(1);

      const paused = (await call(alice, 'GET', '/v1/products?status=paused')).json();
      expect(paused.data.map((p: { id: string }) => p.id)).toEqual([a2.id]);

      expect((await call(alice, 'GET', '/v1/products?limit=500')).statusCode).toBe(400);
    });

    it('updates a product and re-resolves escrow days when the category changes', async () => {
      const product = await createProduct(alice);
      const res = await call(alice, 'PATCH', `/v1/products/${product.id}`, { category: 'electronics', price: 899.9 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ category: 'electronics', escrow_days: 25, price: '899.90', margin: '150.00' });
    });

    it.each([
      ['margin above the stored price', { margin: 500 }],
      ['currency (immutable)', { currency: 'USD' }],
      ['empty patch', {}],
    ])('rejects a PATCH with %s', async (_label, patch) => {
      const product = await createProduct(alice);
      expect((await call(alice, 'PATCH', `/v1/products/${product.id}`, patch)).statusCode).toBe(400);
    });

    it('archives on DELETE (idempotent) and then refuses modifications', async () => {
      const product = await createProduct(alice);
      const first = await call(alice, 'DELETE', `/v1/products/${product.id}`);
      expect(first.json().status).toBe('archived');
      expect((await call(alice, 'DELETE', `/v1/products/${product.id}`)).statusCode).toBe(200);
      const patch = await call(alice, 'PATCH', `/v1/products/${product.id}`, { name: 'Revived' });
      expect(patch.statusCode).toBe(409);
      expect(patch.json().error.code).toBe('PRODUCT_ARCHIVED');
    });

    it('archiving a product stops new code issuance for its links', async () => {
      const product = await createProduct(alice);
      const campaign = await createCampaign(alice, product.id);
      await db.insert(links).values({ campaignId: campaign.id, influencerSlug: 'leo', linkSlug: 'leo-glow' });
      const requestCode = (email: string) =>
        app.inject({
          method: 'POST',
          url: '/v1/codes/request',
          payload: { link_slug: 'leo-glow', buyer: { email } },
          remoteAddress: '10.1.1.1',
        });

      expect((await requestCode('a@gmail.com')).statusCode).toBe(201);
      await call(alice, 'DELETE', `/v1/products/${product.id}`);
      expect((await requestCode('b@gmail.com')).statusCode).toBe(410);
    });

    it('returns 404 for a non-UUID id', async () => {
      const res = await call(alice, 'GET', '/v1/products/not-a-uuid');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  describe('campaigns', () => {
    it('creates a campaign with the platform-controlled fee rate', async () => {
      const product = await createProduct(alice);
      const campaign = await createCampaign(alice, product.id, { commission_rate: 0.125 });
      expect(campaign).toMatchObject({
        product_id: product.id,
        commission_rate: '0.1250',
        platform_fee_rate: '0.0300',
        status: 'active',
      });
    });

    it('does not let sellers set their own platform fee', async () => {
      const product = await createProduct(alice);
      const res = await call(alice, 'POST', '/v1/campaigns', { product_id: product.id, commission_rate: 0.15, platform_fee_rate: 0 });
      expect(res.statusCode).toBe(400);
    });

    it.each([
      ['zero', 0],
      ['above 100%', 1.5],
      ['more than 4 decimals', 0.12345],
    ])('rejects a commission rate that is %s', async (_label, rate) => {
      const product = await createProduct(alice);
      expect((await call(alice, 'POST', '/v1/campaigns', { product_id: product.id, commission_rate: rate })).statusCode).toBe(400);
    });

    it('requires an active product', async () => {
      const product = await createProduct(alice, { status: 'paused' });
      const res = await call(alice, 'POST', '/v1/campaigns', { product_id: product.id, commission_rate: 0.1 });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PRODUCT_NOT_ACTIVE');
    });

    it('lists campaigns filtered by product', async () => {
      const p1 = await createProduct(alice);
      const p2 = await createProduct(alice);
      const c1 = await createCampaign(alice, p1.id);
      await createCampaign(alice, p2.id);
      const res = (await call(alice, 'GET', `/v1/campaigns?product_id=${p1.id}`)).json();
      expect(res.data.map((c: { id: string }) => c.id)).toEqual([c1.id]);
    });

    it('updates the commission rate and enforces status transitions', async () => {
      const product = await createProduct(alice);
      const campaign = await createCampaign(alice, product.id);

      const updated = await call(alice, 'PATCH', `/v1/campaigns/${campaign.id}`, { commission_rate: 0.2, status: 'paused' });
      expect(updated.json()).toMatchObject({ commission_rate: '0.2000', status: 'paused' });

      await call(alice, 'PATCH', `/v1/products/${product.id}`, { status: 'paused' });
      const reactivate = await call(alice, 'PATCH', `/v1/campaigns/${campaign.id}`, { status: 'active' });
      expect(reactivate.statusCode).toBe(409);
      expect(reactivate.json().error.code).toBe('PRODUCT_NOT_ACTIVE');

      await call(alice, 'PATCH', `/v1/campaigns/${campaign.id}`, { status: 'ended' });
      const afterEnd = await call(alice, 'PATCH', `/v1/campaigns/${campaign.id}`, { commission_rate: 0.3 });
      expect(afterEnd.statusCode).toBe(409);
      expect(afterEnd.json().error.code).toBe('CAMPAIGN_ENDED');
    });
  });

  describe('multi-tenant isolation', () => {
    let aliceProduct: { id: string };
    let aliceCampaign: { id: string };

    beforeEach(async () => {
      aliceProduct = await createProduct(alice);
      aliceCampaign = await createCampaign(alice, aliceProduct.id);
    });

    it('hides another seller’s products (404, not 403)', async () => {
      const res = await call(bob, 'GET', `/v1/products/${aliceProduct.id}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('PRODUCT_NOT_FOUND');
      expect((await call(bob, 'GET', '/v1/products')).json().data).toEqual([]);
    });

    it('prevents modifying or archiving another seller’s product', async () => {
      expect((await call(bob, 'PATCH', `/v1/products/${aliceProduct.id}`, { price: 1 })).statusCode).toBe(404);
      expect((await call(bob, 'DELETE', `/v1/products/${aliceProduct.id}`)).statusCode).toBe(404);
      const [row] = await db.select().from(products).where(eq(products.id, aliceProduct.id));
      expect(row).toMatchObject({ price: '499.00', status: 'active' });
    });

    it('prevents creating a campaign on another seller’s product', async () => {
      const res = await call(bob, 'POST', '/v1/campaigns', { product_id: aliceProduct.id, commission_rate: 0.9 });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('PRODUCT_NOT_FOUND');
    });

    it('hides and protects another seller’s campaigns', async () => {
      expect((await call(bob, 'GET', `/v1/campaigns/${aliceCampaign.id}`)).statusCode).toBe(404);
      expect((await call(bob, 'PATCH', `/v1/campaigns/${aliceCampaign.id}`, { commission_rate: 0.99 })).statusCode).toBe(404);
      expect((await call(bob, 'GET', `/v1/campaigns?product_id=${aliceProduct.id}`)).json().data).toEqual([]);
      expect((await call(alice, 'GET', `/v1/campaigns/${aliceCampaign.id}`)).json().commission_rate).toBe('0.1500');
    });
  });
});
