import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';
import { codes, payouts, sales, sellers } from '../src/db/schema.js';
import { decryptSecret } from '../src/lib/crypto.js';
import { HttpShopifyClient, ShopifyApiError, percentageToFraction } from '../src/modules/shopify/shopify.client.js';
import { ShopifyOrderSchema, ShopifyRefundSchema } from '../src/modules/shopify/shopify.schemas.js';
import {
  SHOPIFY_TOKEN_AAD,
  SHOPIFY_WEBHOOK_SECRET_AAD,
  pickReferalsCode,
  refundedCents,
  shopifyWebhookCallbackUrl,
  translateOrder,
} from '../src/modules/shopify/shopify.service.js';

describe('shopifyWebhookCallbackUrl', () => {
  it('prefers PUBLIC_API_URL (trailing slash tolerated, path prefix kept)', () => {
    expect(shopifyWebhookCallbackUrl({ publicApiUrl: 'https://api.referals.mx/', publicLinkBaseUrl: 'https://referals.mx/r' })).toBe(
      'https://api.referals.mx/v1/webhooks/shopify',
    );
    expect(shopifyWebhookCallbackUrl({ publicApiUrl: 'https://gw.example.com/referals', publicLinkBaseUrl: 'https://referals.mx/r' })).toBe(
      'https://gw.example.com/referals/v1/webhooks/shopify',
    );
  });

  it('falls back to the ORIGIN of PUBLIC_LINK_BASE_URL, not its /r path', () => {
    expect(shopifyWebhookCallbackUrl({ publicLinkBaseUrl: 'https://referals.mx/r' })).toBe('https://referals.mx/v1/webhooks/shopify');
  });
});
import { signShopifyPayload, verifyShopifyHmac } from '../src/modules/shopify/shopify.signature.js';
import {
  MockShopifyClient,
  TEST_ENCRYPTION_KEY,
  TEST_SHOPIFY,
  TestClock,
  createTestDb,
  createTestRedis,
  seedAuthenticatedSeller,
  seedLink,
  seedShopifySeller,
} from './helpers.js';

const HOUR = 60 * 60 * 1000;

/** A realistic subset of Shopify's orders/paid payload. */
const shopifyOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 5_123_456_789,
  name: '#1001',
  email: 'Valeria@Gmail.com',
  currency: 'MXN',
  financial_status: 'paid',
  total_line_items_price: '1200.00',
  total_discounts: '180.00',
  subtotal_price: '1020.00',
  total_tax: '163.20',
  total_price: '1283.20',
  discount_codes: [{ code: 'REF-LEO-2345', amount: '180.00', type: 'percentage' }],
  processed_at: '2026-10-13T16:00:00-06:00',
  created_at: '2026-10-13T15:59:00-06:00',
  customer: { email: 'valeria@gmail.com' },
  line_items: [{ id: 1, title: 'Glow Serum', quantity: 1, price: '1200.00' }],
  ...overrides,
});

const shopifyRefund = (overrides: Record<string, unknown> = {}) => ({
  id: 9_001,
  order_id: 5_123_456_789,
  created_at: '2026-10-15T10:00:00-06:00',
  refund_line_items: [],
  transactions: [{ id: 1, kind: 'refund', status: 'success', amount: '1283.20' }],
  ...overrides,
});

// ---------- Pure units ----------

describe('Shopify HMAC (base64)', () => {
  const body = Buffer.from(JSON.stringify(shopifyOrder()));
  const secret = 'shopify_app_secret_0123456789';

  it('accepts the base64 HMAC-SHA256 of the raw body', () => {
    expect(verifyShopifyHmac(body, signShopifyPayload(body, secret), secret)).toBe(true);
  });

  it.each([
    ['wrong secret', () => signShopifyPayload(body, 'other-secret-value')],
    ['hex instead of base64', () => Buffer.from(signShopifyPayload(body, secret), 'base64').toString('hex')],
    ['truncated', () => signShopifyPayload(body, secret).slice(0, 20)],
    ['missing', () => undefined],
    ['garbage', () => '***'],
  ])('rejects %s', (_label, header) => {
    expect(verifyShopifyHmac(body, header(), secret)).toBe(false);
  });

  it('rejects a body modified after signing', () => {
    const sig = signShopifyPayload(body, secret);
    expect(verifyShopifyHmac(Buffer.from(body.toString().replace('1020.00', '9020.00')), sig, secret)).toBe(false);
  });
});

describe('Shopify order/refund translation', () => {
  const order = (o: Record<string, unknown> = {}) => ShopifyOrderSchema.parse(shopifyOrder(o));

  it('maps an order onto the core order.paid contract (net = subtotal, excl. shipping & tax)', () => {
    expect(translateOrder(order())).toEqual({
      event: 'order.paid',
      seller_order_id: '5123456789',
      applied_discount_code: 'REF-LEO-2345',
      currency: 'MXN',
      financials: { gross_total: 120_000n, discount_total: 18_000n, net_total: 102_000n },
      customer: { email: 'valeria@gmail.com' },
      timestamp: new Date('2026-10-13T22:00:00.000Z'),
    });
  });

  it('prefers the Referals code when several discount codes are stacked', () => {
    expect(pickReferalsCode(order({ discount_codes: [{ code: 'WELCOME10' }, { code: 'ref-leo-2345' }] }))).toBe('REF-LEO-2345');
    expect(pickReferalsCode(order({ discount_codes: [{ code: 'WELCOME10' }] }))).toBe('WELCOME10');
    expect(pickReferalsCode(order({ discount_codes: [] }))).toBeNull();
  });

  it('falls back to created_at and customer.email', () => {
    const t = translateOrder(order({ processed_at: null, email: null }));
    expect(t).toMatchObject({ timestamp: new Date('2026-10-13T21:59:00.000Z'), customer: { email: 'valeria@gmail.com' } });
  });

  it('flags inconsistent totals instead of guessing', () => {
    expect(translateOrder(order({ total_discounts: '5000.00' }))).toEqual({ invalid: 'inconsistent_totals' });
  });

  it('sums only successful refund transactions', () => {
    const refund = ShopifyRefundSchema.parse(
      shopifyRefund({
        transactions: [
          { kind: 'refund', status: 'success', amount: '100.00' },
          { kind: 'refund', status: 'failure', amount: '999.00' },
          { kind: 'sale', status: 'success', amount: '50.00' },
          { kind: 'refund', status: 'success', amount: '20.50' },
        ],
      }),
    );
    expect(refundedCents(refund)).toBe(12_050n);
  });
});

describe('HttpShopifyClient', () => {
  const creds = { shopDomain: 'glow-shop.myshopify.com', accessToken: 'shpat_x' };
  const input = {
    code: 'REF-LEO-2345',
    title: 'Referals REF-LEO-2345',
    percentage: '12.50',
    startsAt: new Date('2026-10-13T16:00:00Z'),
    endsAt: new Date('2026-10-15T16:00:00Z'),
  };

  const fakeFetch = (response: unknown, status = 200) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(response), { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it('creates a single-use, once-per-customer, expiring discount via GraphQL', async () => {
    const { fn, calls } = fakeFetch({
      data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } },
    });
    const result = await new HttpShopifyClient({ fetch: fn }).createSingleUseDiscount(creds, input);
    expect(result).toEqual({ id: 'gid://shopify/DiscountCodeNode/1' });

    expect(calls[0]!.url).toBe('https://glow-shop.myshopify.com/admin/api/2026-10/graphql.json');
    expect((calls[0]!.init.headers as Record<string, string>)['x-shopify-access-token']).toBe('shpat_x');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.query).toContain('discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount)');
    expect(body.variables.basicCodeDiscount).toEqual({
      title: 'Referals REF-LEO-2345',
      code: 'REF-LEO-2345',
      startsAt: '2026-10-13T16:00:00.000Z',
      endsAt: '2026-10-15T16:00:00.000Z',
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerSelection: { all: true },
      customerGets: { value: { percentage: 0.125 }, items: { all: true } },
    });
  });

  it('honours a configured API version', async () => {
    const { fn, calls } = fakeFetch({ data: { shop: { name: 'S', myshopifyDomain: 'glow-shop.myshopify.com' } } });
    await new HttpShopifyClient({ fetch: fn, apiVersion: '2027-01' }).getShop(creds);
    expect(calls[0]!.url).toContain('/admin/api/2027-01/graphql.json');
  });

  it.each([
    ['userErrors', { data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['code'], message: 'Code must be unique' }] } } }, 200],
    ['top-level GraphQL errors', { errors: [{ message: 'Access denied for discountCodeBasicCreate' }] }, 200],
    ['an HTTP error', { errors: 'Unauthorized' }, 401],
  ])('throws ShopifyApiError on %s', async (_label, response, status) => {
    const { fn } = fakeFetch(response, status);
    await expect(new HttpShopifyClient({ fetch: fn }).createSingleUseDiscount(creds, input)).rejects.toBeInstanceOf(ShopifyApiError);
  });

  describe('registerWebhooks', () => {
    const CALLBACK = 'https://api.referals.mx/v1/webhooks/shopify';
    type Edge = { node: { id: string; topic: string; uri: string | null } };

    /** Scripted Shopify: answers the list query from `subscriptions`, and creates per `onCreate`. */
    const scriptedShopify = (opts: {
      subscriptions?: Edge['node'][];
      onCreate?: (topic: string) => { userErrors: { field: string[] | null; message: string }[]; webhookSubscription: { id: string; topic: string } | null };
    }) => {
      const subscriptions = [...(opts.subscriptions ?? [])];
      const requests: { query: string; variables: Record<string, unknown> }[] = [];
      const fn = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
        requests.push(body);
        if (body.query.includes('webhookSubscriptions(')) {
          return Response.json({ data: { webhookSubscriptions: { edges: subscriptions.map((node) => ({ node })) } } });
        }
        const topic = body.variables.topic as string;
        const result = opts.onCreate?.(topic) ?? {
          userErrors: [],
          webhookSubscription: { id: `gid://shopify/WebhookSubscription/new-${topic}`, topic },
        };
        if (result.webhookSubscription) subscriptions.push({ id: result.webhookSubscription.id, topic, uri: CALLBACK });
        return Response.json({ data: { webhookSubscriptionCreate: result } });
      }) as unknown as typeof fetch;
      return { fn, requests, subscriptions };
    };

    it('creates both subscriptions with the `uri` destination when none exist', async () => {
      const shop = scriptedShopify({});
      const ids = await new HttpShopifyClient({ fetch: shop.fn }).registerWebhooks(creds, CALLBACK);
      expect(ids).toEqual(['gid://shopify/WebhookSubscription/new-ORDERS_PAID', 'gid://shopify/WebhookSubscription/new-REFUNDS_CREATE']);

      expect(shop.requests[0]!.variables).toEqual({ topics: ['ORDERS_PAID', 'REFUNDS_CREATE'], uri: CALLBACK });
      const creates = shop.requests.filter((r) => r.query.includes('webhookSubscriptionCreate('));
      expect(creates.map((r) => r.variables)).toEqual([
        { topic: 'ORDERS_PAID', webhookSubscription: { uri: CALLBACK } },
        { topic: 'REFUNDS_CREATE', webhookSubscription: { uri: CALLBACK } },
      ]);
      expect(creates[0]!.query).toContain('webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription)');
    });

    it('reuses existing subscriptions instead of duplicating them', async () => {
      const shop = scriptedShopify({ subscriptions: [{ id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_PAID', uri: CALLBACK }] });
      const ids = await new HttpShopifyClient({ fetch: shop.fn }).registerWebhooks(creds, CALLBACK);
      expect(ids).toEqual(['gid://shopify/WebhookSubscription/1', 'gid://shopify/WebhookSubscription/new-REFUNDS_CREATE']);
      const creates = shop.requests.filter((r) => r.query.includes('webhookSubscriptionCreate('));
      expect(creates.map((r) => r.variables.topic)).toEqual(['REFUNDS_CREATE']);
    });

    it('is a no-op when both already exist', async () => {
      const shop = scriptedShopify({
        subscriptions: [
          { id: 'gid://shopify/WebhookSubscription/1', topic: 'ORDERS_PAID', uri: CALLBACK },
          { id: 'gid://shopify/WebhookSubscription/2', topic: 'REFUNDS_CREATE', uri: CALLBACK },
        ],
      });
      const ids = await new HttpShopifyClient({ fetch: shop.fn }).registerWebhooks(creds, CALLBACK);
      expect(ids).toEqual(['gid://shopify/WebhookSubscription/1', 'gid://shopify/WebhookSubscription/2']);
      expect(shop.requests).toHaveLength(1); // just the list query
    });

    it('never adopts a subscription that points somewhere else', async () => {
      const shop = scriptedShopify({
        subscriptions: [{ id: 'gid://shopify/WebhookSubscription/other', topic: 'ORDERS_PAID', uri: 'https://other-app.example/hook' }],
      });
      const ids = await new HttpShopifyClient({ fetch: shop.fn }).registerWebhooks(creds, CALLBACK);
      expect(ids[0]).toBe('gid://shopify/WebhookSubscription/new-ORDERS_PAID');
    });

    it('treats "already been taken" as success by re-reading the subscription', async () => {
      let raced = false;
      const shop = scriptedShopify({
        onCreate: (topic) => {
          if (topic === 'ORDERS_PAID' && !raced) {
            raced = true;
            // A concurrent setup created it between our list and our create.
            shop.subscriptions.push({ id: 'gid://shopify/WebhookSubscription/raced', topic, uri: CALLBACK });
            return { userErrors: [{ field: ['webhookSubscription', 'uri'], message: 'Address for this topic has already been taken' }], webhookSubscription: null };
          }
          return { userErrors: [], webhookSubscription: { id: `gid://shopify/WebhookSubscription/new-${topic}`, topic } };
        },
      });
      const ids = await new HttpShopifyClient({ fetch: shop.fn }).registerWebhooks(creds, CALLBACK);
      expect(ids).toEqual(['gid://shopify/WebhookSubscription/raced', 'gid://shopify/WebhookSubscription/new-REFUNDS_CREATE']);
    });

    it('throws ShopifyApiError with userErrors for other rejections', async () => {
      const shop = scriptedShopify({
        onCreate: () => ({ userErrors: [{ field: ['webhookSubscription', 'uri'], message: 'Address must use https' }], webhookSubscription: null }),
      });
      const err = await new HttpShopifyClient({ fetch: shop.fn }).registerWebhooks(creds, CALLBACK).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShopifyApiError);
      expect((err as ShopifyApiError).userErrors).toEqual([{ field: ['webhookSubscription', 'uri'], message: 'Address must use https' }]);
    });
  });

  it('converts percentages to Shopify fractions', () => {
    expect(percentageToFraction('10.00')).toBe(0.1);
    expect(percentageToFraction('12.50')).toBe(0.125);
    expect(percentageToFraction('100.00')).toBe(1);
  });
});

// ---------- API ----------

describe('Shopify integration API', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let shopify: MockShopifyClient;
  let ipSeq = 0;

  const requestCode = (email: string, linkSlug = 'leo-glow-serum') =>
    app.inject({
      method: 'POST',
      url: '/v1/codes/request',
      payload: { link_slug: linkSlug, buyer: { email } },
      remoteAddress: `10.30.0.${++ipSeq}`,
    });

  const sendShopify = (
    topic: string,
    body: unknown,
    opts: { secret?: string; shop?: string | null; hmac?: string; rawBody?: string } = {},
  ) => {
    const raw = opts.rawBody ?? JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-hmac-sha256': opts.hmac ?? signShopifyPayload(raw, opts.secret ?? TEST_SHOPIFY.webhookSecret),
      'x-shopify-webhook-id': `wh-${Math.random()}`,
      'x-shopify-api-version': '2026-10',
    };
    if (opts.shop !== null) headers['x-shopify-shop-domain'] = opts.shop ?? TEST_SHOPIFY.shopDomain;
    return app.inject({ method: 'POST', url: '/v1/webhooks/shopify', headers, payload: raw });
  };

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-13T16:00:00.000Z'));
    shopify = new MockShopifyClient();
    app = buildApp(
      {
        db,
        redis: await createTestRedis(),
        webhookEncryptionKey: TEST_ENCRYPTION_KEY,
        shopifyClient: shopify,
        now: clock.now,
        generatorOptions: { now: clock.now },
      },
      { logger: false },
    );
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  describe('PATCH /v1/sellers/me/shopify', () => {
    const setup = (auth: { authHeaders: Record<string, string> }, body: Record<string, unknown> = {}) =>
      app.inject({
        method: 'PATCH',
        url: '/v1/sellers/me/shopify',
        headers: auth.authHeaders,
        payload: {
          shop_domain: 'https://Glow-Shop.myshopify.com/',
          access_token: TEST_SHOPIFY.accessToken,
          webhook_secret: TEST_SHOPIFY.webhookSecret,
          discount_percentage: 15,
          ...body,
        },
      });

    it('verifies credentials with Shopify and stores them encrypted', async () => {
      const alice = await seedAuthenticatedSeller(db);
      const res = await setup(alice);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        shop_domain: 'glow-shop.myshopify.com',
        shop_name: 'Glow Shop MX',
        discount_percentage: '15.00',
        connected: true,
        webhook_topics: ['orders/paid', 'refunds/create'],
        webhook_callback_url: 'https://referals.mx/v1/webhooks/shopify',
        webhook_subscription_ids: ['gid://shopify/WebhookSubscription/ORDERS_PAID', 'gid://shopify/WebhookSubscription/REFUNDS_CREATE'],
      });
      expect(res.body).not.toContain(TEST_SHOPIFY.accessToken);
      expect(res.body).not.toContain(TEST_SHOPIFY.webhookSecret);

      const [row] = await db.select().from(sellers).where(eq(sellers.id, alice.seller.id));
      expect(row!.shopifyShopDomain).toBe('glow-shop.myshopify.com');
      expect(row!.shopifyAccessToken).toMatch(/^v1:/);
      expect(row!.shopifyWebhookSecret).toMatch(/^v1:/);
      expect(decryptSecret(row!.shopifyAccessToken!, TEST_ENCRYPTION_KEY, SHOPIFY_TOKEN_AAD)).toBe(TEST_SHOPIFY.accessToken);
      expect(decryptSecret(row!.shopifyWebhookSecret!, TEST_ENCRYPTION_KEY, SHOPIFY_WEBHOOK_SECRET_AAD)).toBe(TEST_SHOPIFY.webhookSecret);
      // Column-bound AAD: the token ciphertext can't be read as the webhook secret.
      expect(() => decryptSecret(row!.shopifyAccessToken!, TEST_ENCRYPTION_KEY, SHOPIFY_WEBHOOK_SECRET_AAD)).toThrow();
    });

    it('rejects credentials Shopify refuses, or that belong to another shop (422)', async () => {
      const alice = await seedAuthenticatedSeller(db);
      shopify.getShopError = new ShopifyApiError('Unauthorized', 401);
      expect((await setup(alice)).json().error.code).toBe('SHOPIFY_CREDENTIALS_INVALID');

      shopify.getShopError = null;
      shopify.reportedDomain = 'someone-else.myshopify.com';
      const res = await setup(alice);
      expect(res.statusCode).toBe(422);
      const [row] = await db.select().from(sellers).where(eq(sellers.id, alice.seller.id));
      expect(row!.shopifyShopDomain).toBeNull();
    });

    it('refuses to connect a store already connected to another seller (409)', async () => {
      await seedShopifySeller(db);
      const bob = await seedAuthenticatedSeller(db, 'Bob');
      const res = await setup(bob);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SHOPIFY_SHOP_TAKEN');
    });

    it.each([
      ['a non-myshopify domain', { shop_domain: 'glowshop.com' }],
      ['a non-Shopify token', { access_token: 'abc123' }],
      ['a 0% discount', { discount_percentage: 0 }],
      ['a 3-decimal discount', { discount_percentage: 10.125 }],
      ['unknown fields', { scope: 'all' }],
    ])('rejects %s with 400', async (_label, body) => {
      const alice = await seedAuthenticatedSeller(db);
      expect((await setup(alice, body)).statusCode).toBe(400);
    });

    describe('automatic webhook registration', () => {
      it('subscribes ORDERS_PAID and REFUNDS_CREATE to our callback with the seller’s credentials', async () => {
        const alice = await seedAuthenticatedSeller(db);
        expect((await setup(alice)).statusCode).toBe(200);
        expect(shopify.webhookRegistrations).toEqual([
          {
            creds: { shopDomain: TEST_SHOPIFY.shopDomain, accessToken: TEST_SHOPIFY.accessToken },
            callbackUrl: 'https://referals.mx/v1/webhooks/shopify',
          },
        ]);
      });

      it('uses PUBLIC_API_URL when configured', async () => {
        await app.close();
        app = buildApp(
          {
            db,
            redis: await createTestRedis(),
            webhookEncryptionKey: TEST_ENCRYPTION_KEY,
            shopifyClient: shopify,
            publicApiUrl: 'https://api.referals.mx/',
            now: clock.now,
          },
          { logger: false },
        );
        const alice = await seedAuthenticatedSeller(db);
        expect((await setup(alice)).json().webhook_callback_url).toBe('https://api.referals.mx/v1/webhooks/shopify');
        expect(shopify.webhookRegistrations[0]!.callbackUrl).toBe('https://api.referals.mx/v1/webhooks/shopify');
      });

      it('does not connect the store when Shopify refuses the subscriptions (422), and saves nothing', async () => {
        const alice = await seedAuthenticatedSeller(db);
        shopify.webhookError = new ShopifyApiError('rejected', undefined, [
          { field: ['webhookSubscription', 'uri'], message: 'Address is invalid' },
        ]);
        const res = await setup(alice);
        expect(res.statusCode).toBe(422);
        expect(res.json().error).toMatchObject({
          code: 'SHOPIFY_WEBHOOK_REGISTRATION_FAILED',
          details: { messages: ['Address is invalid'] },
        });
        const [row] = await db.select().from(sellers).where(eq(sellers.id, alice.seller.id));
        expect(row!.shopifyShopDomain).toBeNull();
        expect(row!.shopifyAccessToken).toBeNull();
      });

      it('answers a retryable 502 when Shopify is unreachable, and saves nothing', async () => {
        const alice = await seedAuthenticatedSeller(db);
        shopify.webhookError = new ShopifyApiError('Shopify request failed: timeout');
        const res = await setup(alice);
        expect(res.statusCode).toBe(502);
        expect(res.headers['retry-after']).toBe('5');
        expect(res.json().error.code).toBe('SHOPIFY_UNAVAILABLE');
        const [row] = await db.select().from(sellers).where(eq(sellers.id, alice.seller.id));
        expect(row!.shopifyShopDomain).toBeNull();
      });

      it('never registers webhooks on a store owned by another seller', async () => {
        await seedShopifySeller(db);
        const bob = await seedAuthenticatedSeller(db, 'Bob');
        expect((await setup(bob)).statusCode).toBe(409);
        expect(shopify.webhookRegistrations).toHaveLength(0);
      });

      it('lets the owner reconnect (e.g. new token) and re-ensures the subscriptions', async () => {
        const alice = await seedAuthenticatedSeller(db);
        await setup(alice);
        const again = await setup(alice, { discount_percentage: 20 });
        expect(again.statusCode).toBe(200);
        expect(again.json().discount_percentage).toBe('20.00');
        expect(shopify.webhookRegistrations).toHaveLength(2);
      });
    });

    it('requires seller authentication', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/v1/sellers/me/shopify', payload: {} });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('discount provisioning on coupon request', () => {
    it('creates the code in Shopify before showing it to the buyer', async () => {
      const seller = await seedShopifySeller(db, { discountPercentage: '15.00' });
      await seedLink(db, { sellerId: seller.seller.id, influencerSlug: 'LEO' });

      const res = await requestCode('valeria@gmail.com');
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(shopify.discounts).toEqual([
        {
          creds: { shopDomain: TEST_SHOPIFY.shopDomain, accessToken: TEST_SHOPIFY.accessToken },
          input: {
            code: body.code,
            title: `Referals ${body.code}`,
            percentage: '15.00',
            startsAt: new Date(body.issued_at),
            endsAt: new Date(body.expires_at),
          },
        },
      ]);
      expect(Date.parse(body.expires_at) - Date.parse(body.issued_at)).toBe(48 * HOUR);
    });

    it('does not call Shopify for sellers without the integration', async () => {
      await seedLink(db, { influencerSlug: 'LEO' });
      expect((await requestCode('valeria@gmail.com')).statusCode).toBe(201);
      expect(shopify.discounts).toHaveLength(0);
    });

    it('does not re-provision when returning an existing code (409)', async () => {
      const seller = await seedShopifySeller(db);
      await seedLink(db, { sellerId: seller.seller.id, influencerSlug: 'LEO' });
      await requestCode('valeria@gmail.com');
      expect((await requestCode('valeria@gmail.com')).statusCode).toBe(409);
      expect(shopify.discounts).toHaveLength(1);
    });

    it('never shows a code Shopify did not accept: revokes it and answers a retryable 503', async () => {
      const seller = await seedShopifySeller(db);
      await seedLink(db, { sellerId: seller.seller.id, influencerSlug: 'LEO' });
      shopify.failWith = new ShopifyApiError('Shopify responded 503', 503);

      const failed = await requestCode('valeria@gmail.com');
      expect(failed.statusCode).toBe(503);
      expect(failed.headers['retry-after']).toBe('2');
      expect(failed.json().error.code).toBe('DISCOUNT_PROVISIONING_FAILED');
      expect(failed.body).not.toMatch(/REF-LEO-/);
      const [revoked] = await db.select().from(codes);
      expect(revoked!.status).toBe('revoked');

      // Shopify recovers: the retry issues (and provisions) a fresh code.
      shopify.failWith = null;
      const retry = await requestCode('valeria@gmail.com');
      expect(retry.statusCode).toBe(201);
      expect(retry.json().code).not.toBe(revoked!.code);
      expect(shopify.discounts.map((d) => d.input.code)).toEqual([retry.json().code]);
    });
  });

  describe('POST /v1/webhooks/shopify', () => {
    let sellerId: string;
    let code: string;

    beforeEach(async () => {
      const seller = await seedShopifySeller(db);
      sellerId = seller.seller.id;
      await seedLink(db, { sellerId, influencerSlug: 'LEO' });
      code = (await requestCode('valeria@gmail.com')).json().code;
    });

    it('attributes an orders/paid webhook and opens an escrow payout on the net subtotal', async () => {
      const res = await sendShopify('orders/paid', shopifyOrder({ discount_codes: [{ code }] }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        topic: 'orders/paid',
        result: {
          status: 'processed',
          attribution: { attributed: true, reason: 'valid_code', code },
          payout: { amount: '153.00', escrow_days: 14, status: 'in_escrow' }, // 15% of 1020.00
        },
      });
      const [sale] = await db.select().from(sales);
      expect(sale).toMatchObject({ sellerId, sellerOrderId: '5123456789', netTotal: '1020.00', customerEmail: 'valeria@gmail.com' });
    });

    it('is idempotent across Shopify redeliveries', async () => {
      const first = await sendShopify('orders/paid', shopifyOrder({ discount_codes: [{ code }] }));
      const again = await sendShopify('orders/paid', shopifyOrder({ discount_codes: [{ code }] }));
      expect(again.statusCode).toBe(200);
      expect(again.json().result).toEqual({ status: 'already_processed', sale_id: first.json().result.sale_id });
      expect(await db.select().from(payouts)).toHaveLength(1);
    });

    it('records orders without a Referals code as unattributed', async () => {
      const res = await sendShopify('orders/paid', shopifyOrder({ discount_codes: [{ code: 'WELCOME10' }] }));
      expect(res.json().result).toMatchObject({ attribution: { attributed: false, reason: 'code_not_found' }, payout: null });
    });

    describe('verification', () => {
      it.each([
        ['wrong secret', { secret: 'not-the-shopify-secret' }],
        ['malformed HMAC', { hmac: 'zzz' }],
        ['unknown shop', { shop: 'other-shop.myshopify.com' }],
        ['missing shop header', { shop: null }],
      ])('rejects %s with 401', async (_label, opts) => {
        const res = await sendShopify('orders/paid', shopifyOrder({ discount_codes: [{ code }] }), opts);
        expect(res.statusCode).toBe(401);
        expect(await db.select().from(sales)).toHaveLength(0);
      });

      it('verifies the exact raw bytes', async () => {
        const signed = JSON.stringify(shopifyOrder({ discount_codes: [{ code }] }));
        const res = await sendShopify('orders/paid', null, {
          rawBody: signed.replace('1020.00', '1.00'),
          hmac: signShopifyPayload(signed, TEST_SHOPIFY.webhookSecret),
        });
        expect(res.statusCode).toBe(401);
      });

      it('rejects suspended sellers', async () => {
        await db.update(sellers).set({ status: 'suspended' }).where(eq(sellers.id, sellerId));
        expect((await sendShopify('orders/paid', shopifyOrder())).statusCode).toBe(401);
      });
    });

    it.each([
      ['an unsupported topic', 'products/update', { id: 1 }, 'unsupported_topic'],
      ['an unusable order payload', 'orders/paid', { id: 1, currency: 'MXN' }, 'invalid_payload'],
      ['inconsistent order totals', 'orders/paid', shopifyOrder({ subtotal_price: '99999.00' }), 'inconsistent_totals'],
    ])('acknowledges %s with 200 so Shopify does not retry', async (_label, topic, body, reason) => {
      const res = await sendShopify(topic, body);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ topic, result: { status: 'ignored', reason } });
      expect(await db.select().from(sales)).toHaveLength(0);
    });

    describe('refunds/create', () => {
      beforeEach(async () => {
        await sendShopify('orders/paid', shopifyOrder({ discount_codes: [{ code }] }));
      });

      it('reverses the commission on a full refund', async () => {
        const res = await sendShopify('refunds/create', shopifyRefund());
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
          topic: 'refunds/create',
          result: { status: 'processed', sale_status: 'refunded', payouts: [{ status: 'cancelled' }] },
        });
        const [sale] = await db.select().from(sales);
        expect(sale).toMatchObject({ status: 'refunded', refundEvent: 'order.refunded' });
      });

      it('treats a refund covering at least the net merchandise total as full', async () => {
        const res = await sendShopify('refunds/create', shopifyRefund({ transactions: [{ kind: 'refund', status: 'success', amount: '1020.00' }] }));
        expect(res.json().result.status).toBe('processed');
      });

      it('leaves the commission in place for a partial refund and flags it', async () => {
        const res = await sendShopify('refunds/create', shopifyRefund({ transactions: [{ kind: 'refund', status: 'success', amount: '200.00' }] }));
        expect(res.json()).toEqual({ topic: 'refunds/create', result: { status: 'ignored', reason: 'partial_refund' } });
        const [payout] = await db.select().from(payouts);
        expect(payout!.status).toBe('in_escrow');
      });

      it.each([
        ['a zero-amount refund (restock only)', shopifyRefund({ transactions: [] }), 'no_refunded_amount'],
        ['an order Referals never saw', shopifyRefund({ order_id: 42 }), 'sale_not_found'],
      ])('acknowledges %s without changes', async (_label, body, reason) => {
        const res = await sendShopify('refunds/create', body);
        expect(res.json().result).toEqual({ status: 'ignored', reason });
        const [payout] = await db.select().from(payouts);
        expect(payout!.status).toBe('in_escrow');
      });

      it('is idempotent', async () => {
        await sendShopify('refunds/create', shopifyRefund());
        const again = await sendShopify('refunds/create', shopifyRefund());
        expect(again.json().result.status).toBe('already_processed');
      });
    });
  });

  it('end to end: connect store -> buyer code provisioned in Shopify -> Shopify order attributes the creator', async () => {
    const alice = await seedAuthenticatedSeller(db);
    const connect = await app.inject({
      method: 'PATCH',
      url: '/v1/sellers/me/shopify',
      headers: alice.authHeaders,
      payload: { shop_domain: TEST_SHOPIFY.shopDomain, access_token: TEST_SHOPIFY.accessToken, webhook_secret: TEST_SHOPIFY.webhookSecret },
    });
    expect(connect.json().discount_percentage).toBe('10.00');
    await seedLink(db, { sellerId: alice.seller.id, influencerSlug: 'LEO' });

    const issued = (await requestCode('buyer@gmail.com')).json();
    expect(shopify.discounts.map((d) => d.input.code)).toEqual([issued.code]);

    clock.advance(2 * HOUR);
    const order = shopifyOrder({ discount_codes: [{ code: issued.code.toLowerCase() }], processed_at: clock.now().toISOString() });
    const paid = await sendShopify('orders/paid', order);
    expect(paid.json().result).toMatchObject({ attribution: { attributed: true, code: issued.code }, payout: { amount: '153.00' } });

    const [row] = await db.select().from(codes).where(eq(codes.code, issued.code));
    expect(row!.status).toBe('applied');
  });
});
