import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { campaigns, codes, creators, links, products } from '../../src/db/schema.js';
import { creatorStorefrontItems } from '../../src/db/schema/storefront.js';
import { signPayload } from '../../src/modules/webhooks/signature.js';
import {
  MockShopifyClient,
  TEST_ENCRYPTION_KEY,
  TEST_WEBHOOK_SECRET,
  TestClock,
  createTestDb,
  createTestRedis,
  expectUniqueIds,
  seedCreator,
  seedLink,
  seedSeller,
  seedShopifySeller,
} from '../helpers.js';

const AGENTS_FORMAT = /^REF-[A-Z0-9]{3,5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
const HOUR = 60 * 60 * 1000;

describe('creator storefront & instant coupons', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let shopify: MockShopifyClient;
  let sellerId: string;
  let leo: Awaited<ReturnType<typeof seedCreator>>;
  let ipSeq = 0;
  const nextIp = () => `10.40.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

  /** A seller product + campaign + LEO's link for it; returns ids for storefront curation. */
  const seedProduct = async (linkSlug: string, overrides: { name?: string; category?: string; seller?: string } = {}) => {
    const { product, campaign, link } = await seedLink(db, {
      sellerId: overrides.seller ?? sellerId,
      influencerSlug: 'LEO',
      linkSlug,
      category: overrides.category ?? 'beauty',
    });
    await db.update(links).set({ creatorId: leo.id }).where(eq(links.id, link.id));
    if (overrides.name) await db.update(products).set({ name: overrides.name }).where(eq(products.id, product.id));
    return { productId: product.id, campaignId: campaign.id, linkId: link.id };
  };

  const addItem = (body: Record<string, unknown>, headers = leo.authHeaders) =>
    app.inject({ method: 'POST', url: '/v1/creators/me/storefront/items', headers, payload: body });

  const requestCoupon = (productId: string, buyer: Record<string, unknown> = { email: 'valeria@gmail.com' }, ip = nextIp(), slug = 'leo') =>
    app.inject({
      method: 'POST',
      url: `/v1/storefronts/${slug}/products/${productId}/coupons`,
      payload: { buyer, client_context: { user_agent: 'vitest' } },
      remoteAddress: ip,
    });

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-26T18:00:00.000Z'));
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
    sellerId = (await seedSeller(db)).id;
    leo = await seedCreator(db, { slug: 'LEO', name: 'Leo Mendez', handle: '@soyleomx' });
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  describe('creator curation (/v1/creators/me/storefront)', () => {
    it('adds a product card from the creator’s own link (201), then re-configures it (200)', async () => {
      const p = await seedProduct('leo-glow', { name: 'Glow Serum' });
      const created = await addItem({ link_id: p.linkId, custom_hook_text: 'Mi básico diario', is_featured: true });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        product_id: p.productId,
        product_name: 'Glow Serum',
        campaign_id: p.campaignId,
        link_id: p.linkId,
        link_slug: 'leo-glow',
        is_featured: true,
        custom_hook_text: 'Mi básico diario',
        is_active: true,
        is_live: true,
      });

      const again = await addItem({ link_id: p.linkId, display_order: 3 });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ id: created.json().id, display_order: 3, is_featured: false });
      expect(await db.select().from(creatorStorefrontItems)).toHaveLength(1);
    });

    it('refuses links that belong to another creator (404)', async () => {
      const ana = await seedCreator(db, { slug: 'ANA', email: 'ana@creators.mx' });
      const p = await seedProduct('leo-glow');
      const res = await addItem({ link_id: p.linkId }, ana.authHeaders);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('LINK_NOT_FOUND');
    });

    it('lists, updates and removes items; scoped to the authenticated creator', async () => {
      const p = await seedProduct('leo-glow');
      const item = (await addItem({ link_id: p.linkId })).json();

      const list = await app.inject({ method: 'GET', url: '/v1/creators/me/storefront', headers: leo.authHeaders });
      expect(list.json()).toMatchObject({ creator_slug: 'LEO', items: [{ id: item.id }] });

      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/creators/me/storefront/items/${item.id}`,
        headers: leo.authHeaders,
        payload: { is_active: false, custom_hook_text: null },
      });
      expect(patched.json()).toMatchObject({ is_active: false, is_live: false, custom_hook_text: null });

      const ana = await seedCreator(db, { slug: 'ANA', email: 'ana@creators.mx' });
      const foreign = await app.inject({ method: 'DELETE', url: `/v1/creators/me/storefront/items/${item.id}`, headers: ana.authHeaders });
      expect(foreign.statusCode).toBe(404);

      const removed = await app.inject({ method: 'DELETE', url: `/v1/creators/me/storefront/items/${item.id}`, headers: leo.authHeaders });
      expect(removed.statusCode).toBe(204);
      expect(await db.select().from(creatorStorefrontItems)).toHaveLength(0);
    });

    it.each([
      ['a hook over 280 chars', { custom_hook_text: 'x'.repeat(281) }],
      ['an unknown field', { product_id: '00000000-0000-4000-8000-000000000000' }],
      ['a negative display order', { display_order: -1 }],
    ])('rejects %s with 400', async (_label, extra) => {
      const p = await seedProduct('leo-glow');
      expect((await addItem({ link_id: p.linkId, ...extra })).statusCode).toBe(400);
    });

    it('requires creator authentication', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/creators/me/storefront' })).statusCode).toBe(401);
    });

    it('lets creators fill their public profile; verification stays platform-controlled', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/creators/me',
        headers: leo.authHeaders,
        payload: { bio: 'Skincare honesto.', avatar_url: 'https://cdn.example.mx/leo.jpg', instagram_handle: 'SoyLeoMX', tiktok_handle: '@soyleo' },
      });
      expect(res.json()).toMatchObject({
        bio: 'Skincare honesto.',
        avatar_url: 'https://cdn.example.mx/leo.jpg',
        instagram_handle: '@soyleomx',
        tiktok_handle: '@soyleo',
        is_verified: false,
      });
      for (const bad of [{ is_verified: true }, { avatar_url: 'http://insecure.example/leo.jpg' }, { avatar_url: 'javascript:alert(1)' }]) {
        expect((await app.inject({ method: 'PATCH', url: '/v1/creators/me', headers: leo.authHeaders, payload: bad })).statusCode).toBe(400);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /v1/storefronts/:slug (public)', () => {
    it('returns the public profile and live products, featured first', async () => {
      await db.update(creators).set({ bio: 'Skincare honesto.', isVerified: true }).where(eq(creators.id, leo.id));
      const a = await seedProduct('leo-a', { name: 'Producto A' });
      const b = await seedProduct('leo-b', { name: 'Producto B' });
      await addItem({ link_id: a.linkId, display_order: 1 });
      await addItem({ link_id: b.linkId, display_order: 5, is_featured: true, custom_hook_text: 'Lo amo' });

      const res = await app.inject({ method: 'GET', url: '/v1/storefronts/leo' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=30');
      expect(res.json()).toEqual({
        creator: {
          slug: 'LEO',
          name: 'Leo Mendez',
          handle: '@soyleomx',
          bio: 'Skincare honesto.',
          avatar_url: null,
          instagram_handle: null,
          tiktok_handle: null,
          is_verified: true,
        },
        products: [
          { product_id: b.productId, name: 'Producto B', image_url: null, price: '499.00', currency: 'MXN', category: 'beauty', hook: 'Lo amo', is_featured: true, link_slug: 'leo-b' },
          { product_id: a.productId, name: 'Producto A', image_url: null, price: '499.00', currency: 'MXN', category: 'beauty', hook: null, is_featured: false, link_slug: 'leo-a' },
        ],
      });
    });

    it('never exposes creator PII, banking data or seller internals', async () => {
      const p = await seedProduct('leo-glow');
      await addItem({ link_id: p.linkId });
      const body = (await app.inject({ method: 'GET', url: '/v1/storefronts/LEO' })).body.toLowerCase();
      for (const secret of ['email', 'creators.mx', 'clabe', '002010077777777771', 'api_key', 'commission', 'margin', 'checkout', 'seller']) {
        expect(body).not.toContain(secret);
      }
    });

    it('hides inactive items and items whose campaign or product is no longer live', async () => {
      const a = await seedProduct('leo-a');
      const b = await seedProduct('leo-b');
      const c = await seedProduct('leo-c');
      await addItem({ link_id: a.linkId });
      await addItem({ link_id: b.linkId, is_active: false });
      await addItem({ link_id: c.linkId });
      await db.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, c.campaignId));

      const res = (await app.inject({ method: 'GET', url: '/v1/storefronts/leo' })).json();
      expect(res.products.map((p: { link_slug: string }) => p.link_slug)).toEqual(['leo-a']);
    });

    it.each([
      ['an unknown creator', 'NOPE'],
      ['a malformed slug', 'a!'],
    ])('returns 404 for %s', async (_label, slug) => {
      const res = await app.inject({ method: 'GET', url: `/v1/storefronts/${encodeURIComponent(slug)}` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('STOREFRONT_NOT_FOUND');
    });

    it('returns 404 for a suspended creator', async () => {
      await db.update(creators).set({ status: 'suspended' }).where(eq(creators.id, leo.id));
      expect((await app.inject({ method: 'GET', url: '/v1/storefronts/leo' })).statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /v1/storefronts/:slug/products/:productId/coupons', () => {
    let product: Awaited<ReturnType<typeof seedProduct>>;

    beforeEach(async () => {
      product = await seedProduct('leo-glow', { name: 'Glow Serum' });
      await addItem({ link_id: product.linkId });
    });

    it('issues a single-use REF coupon, expiring in 48h, stored as an `issued` code on the item’s link', async () => {
      const res = await requestCoupon(product.productId);
      expect(res.statusCode).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json();
      expect(body).toEqual({
        code: expect.stringMatching(AGENTS_FORMAT),
        status: 'issued',
        issued_at: '2026-10-26T18:00:00.000Z',
        expires_at: '2026-10-28T18:00:00.000Z',
        auto_apply_url: `https://shop.example.mx/checkout?discount=${body.code}&utm_source=referals&utm_campaign=LEO`,
        product_id: product.productId,
        creator_slug: 'LEO',
        delivery: { whatsapp_backup: 'not_requested' },
      });
      expect(body.code.startsWith('REF-LEO-')).toBe(true);

      const [row] = await db.select().from(codes);
      expect(row).toMatchObject({
        code: body.code,
        linkId: product.linkId,
        buyerEmail: 'valeria@gmail.com',
        status: 'issued',
        issuedAt: clock.now(),
        expiresAt: new Date(clock.now().getTime() + 48 * HOUR),
      });
    });

    it('returns the existing code (409) to the same buyer within 24h', async () => {
      const first = (await requestCoupon(product.productId)).json();
      const res = await requestCoupon(product.productId);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: 'ACTIVE_CODE_EXISTS' },
        existing_code: { code: first.code, status: 'issued' },
        product_id: product.productId,
        creator_slug: 'LEO',
      });
      expect(await db.select().from(codes)).toHaveLength(1);
    });

    it('ignores any link_slug the client sends: the item decides attribution', async () => {
      const other = await seedProduct('leo-other');
      const res = await app.inject({
        method: 'POST',
        url: `/v1/storefronts/leo/products/${product.productId}/coupons`,
        payload: { link_slug: 'leo-other', buyer: { email: 'valeria@gmail.com' } },
        remoteAddress: nextIp(),
      });
      expect(res.statusCode).toBe(201);
      const [row] = await db.select().from(codes);
      expect(row!.linkId).toBe(product.linkId);
      expect(row!.linkId).not.toBe(other.linkId);
    });

    it('applies the IP sliding window before anything else (429 + Retry-After)', async () => {
      const ip = '189.200.45.12';
      for (let i = 0; i < 5; i++) {
        expect((await requestCoupon(product.productId, { email: `b${i}@gmail.com` }, ip)).statusCode).toBe(201);
      }
      const res = await requestCoupon(product.productId, { email: 'b6@gmail.com' }, ip);
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('3600');
    });

    it.each([
      ['a disposable email', { email: 'x@mailinator.com' }, 422, 'DISPOSABLE_EMAIL'],
      ['no buyer contact', {}, 400, 'VALIDATION_ERROR'],
      ['a non-E.164 phone', { phone: '5512345678' }, 400, 'VALIDATION_ERROR'],
    ])('rejects %s', async (_label, buyer, status, code) => {
      const res = await requestCoupon(product.productId, buyer);
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(code);
      expect(await db.select().from(codes)).toHaveLength(0);
    });

    it('404s for products outside the storefront, inactive items, unknown creators and malformed ids', async () => {
      const notListed = await seedProduct('leo-unlisted');
      expect((await requestCoupon(notListed.productId)).json().error.code).toBe('PRODUCT_NOT_IN_STOREFRONT');
      expect((await requestCoupon(product.productId, undefined, undefined, 'NOPE')).json().error.code).toBe('STOREFRONT_NOT_FOUND');
      const bad = await app.inject({ method: 'POST', url: '/v1/storefronts/leo/products/not-a-uuid/coupons', payload: {}, remoteAddress: nextIp() });
      expect(bad.statusCode).toBe(404);

      await db.update(creatorStorefrontItems).set({ isActive: false });
      expect((await requestCoupon(product.productId)).statusCode).toBe(404);
    });

    it('410s when the backing campaign is paused', async () => {
      await db.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, product.campaignId));
      const res = await requestCoupon(product.productId);
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toMatchObject({ code: 'LINK_INACTIVE', details: { status: 'campaign_inactive' } });
    });

    it('answers well inside the 400ms budget', async () => {
      const timings: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        expect((await requestCoupon(product.productId, { email: `t${i}@gmail.com` })).statusCode).toBe(201);
        timings.push(performance.now() - start);
      }
      timings.sort((x, y) => x - y);
      expect(timings[2]).toBeLessThan(400); // median, in-process DB
    });

    it('is attributed and paid by the existing webhook pipeline (deterministic attribution)', async () => {
      const coupon = (await requestCoupon(product.productId)).json();
      clock.advance(2 * HOUR);
      const raw = JSON.stringify({
        event: 'order.paid',
        seller_order_id: 'ORD-SF-1',
        applied_discount_code: coupon.code,
        currency: 'MXN',
        financials: { gross_total: 1020, discount_total: 0, net_total: 1020 },
        timestamp: clock.now().toISOString(),
      });
      const paid = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/orders/paid',
        headers: { 'content-type': 'application/json', 'x-referals-seller-id': sellerId, 'x-referals-signature': signPayload(raw, TEST_WEBHOOK_SECRET) },
        payload: raw,
      });
      expect(paid.json()).toMatchObject({
        attribution: { attributed: true, reason: 'valid_code', code: coupon.code },
        payout: { amount: '153.00', status: 'in_escrow', escrow_days: 14 },
      });
      const [row] = await db.select().from(codes);
      expect(row!.status).toBe('applied');
    });
  });

  it('provisions storefront coupons in Shopify like any other coupon', async () => {
    const shop = await seedShopifySeller(db);
    const p = await seedProduct('leo-shopify', { seller: shop.seller.id });
    await addItem({ link_id: p.linkId });
    const res = await requestCoupon(p.productId);
    expect(res.statusCode).toBe(201);
    expect(shopify.discounts.map((d) => d.input.code)).toEqual([res.json().code]);
  });

  // ---------------------------------------------------------------------------
  describe('storefront page (/c/:slug and /@:slug)', () => {
    beforeEach(async () => {
      await db
        .update(creators)
        .set({ bio: '<script>alert("bio")</script>', instagramHandle: '@soyleomx', isVerified: true })
        .where(eq(creators.id, leo.id));
      const a = await seedProduct('leo-glow', { name: 'Glow Serum' });
      const b = await seedProduct('leo-fps', { name: 'FPS 50 <b>Mineral</b>' });
      await addItem({ link_id: a.linkId, is_featured: true, custom_hook_text: 'Mi básico </script><script>alert(1)</script>' });
      await addItem({ link_id: b.linkId });
    });

    it('serves a CSP-locked, flat, mobile-first page with no-JS fallback links', async () => {
      const res = await app.inject({ method: 'GET', url: '/c/leo' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      const csp = res.headers['content-security-policy'] as string;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(csp).toContain("img-src 'self' data: https:"); // creator avatars
      expect(csp).toContain("connect-src 'self'");
      expect(res.headers['x-frame-options']).toBe('DENY');

      const html = res.body;
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect(html).toContain('<h1>Leo Mendez</h1><span class="pill pill-verified">Verificado</span>');
      expect(html).toContain('href="https://www.instagram.com/soyleomx"');
      expect(html).toContain('<a class="btn" id="sf-pick-0" href="/r/leo-glow">Obtener mi cupón</a>');
      expect(html).toContain('<a class="btn" id="sf-pick-1" href="/r/leo-fps">Obtener mi cupón</a>');
      expect(html).toContain('<li class="card product featured">');
      expect(html).toContain('.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on}');
      expect(html).toContain('<p class="price num">$499.00 MXN</p>');
      for (const banned of ['gradient', 'box-shadow', 'blur(', 'filter:']) expect(html).not.toContain(banned);
      expect(html).not.toMatch(/ style="/);
      expect(html).not.toMatch(/Referals/);
      expect(html).toContain('Powered by Referrals');
      expectUniqueIds(html);
    });

    it('escapes creator- and seller-controlled text', async () => {
      const html = (await app.inject({ method: 'GET', url: '/c/leo' })).body;
      expect(html).not.toContain('<script>alert("bio")</script>');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<b>Mineral</b>');
      expect(html).toContain('FPS 50 &lt;b&gt;Mineral&lt;/b&gt;');
    });

    it('serves /@:slug as an alias and a 404 page for unknown creators', async () => {
      const alias = await app.inject({ method: 'GET', url: '/@LEO' });
      expect(alias.statusCode).toBe(200);
      expect(alias.body).toContain('<h1>Leo Mendez</h1>');
      const missing = await app.inject({ method: 'GET', url: '/c/nobody' });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toContain('Tienda no encontrada');
    });

    it('runs the real page script: pick a product, get the coupon inline, copy it, go to the store', async () => {
      const html = (await app.inject({ method: 'GET', url: '/c/leo' })).body;
      const page = bootStorefront(html, app, nextIp());

      // Pick the second product (FPS 50).
      const prevented = page.el['sf-pick-1']!.fire('click');
      expect(prevented).toBe(true);
      expect(page.el['sf-request']!.classList.contains('hidden')).toBe(false);
      expect(page.el['sf-selected-name']!.textContent).toBe('FPS 50 <b>Mineral</b>'); // textContent, not HTML

      page.el['sf-email']!.value = 'valeria@gmail.com';
      page.el['sf-form']!.fire('submit');
      await vi.waitFor(() => expect(page.el['sf-code']!.textContent).toMatch(AGENTS_FORMAT));
      const code = page.el['sf-code']!.textContent;
      const fps = (await app.inject({ method: 'GET', url: '/v1/storefronts/leo' })).json().products[1];
      expect(page.requests[0]).toEqual({
        url: `/v1/storefronts/LEO/products/${fps.product_id}/coupons`,
        body: { buyer: { email: 'valeria@gmail.com', phone: null, send_whatsapp_backup: false }, client_context: { user_agent: 'vitest' } },
      });
      expect(page.el['sf-result']!.classList.contains('hidden')).toBe(false);
      expect(page.el['sf-timer']!.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);

      page.el['sf-copy']!.fire('click');
      await vi.waitFor(() => expect(page.el['sf-copy']!.textContent).toBe('¡Copiado!'));
      expect(page.clipboard).toEqual([code]);

      page.el['sf-go']!.fire('click');
      await vi.waitFor(() => expect(page.navigations).toHaveLength(1));
      expect(page.navigations[0]).toContain(`discount=${code}`);
    });

    it('switching products reuses the same buttons without stacking handlers', async () => {
      const html = (await app.inject({ method: 'GET', url: '/c/leo' })).body;
      const page = bootStorefront(html, app, nextIp());
      for (const i of [0, 1]) {
        page.el[`sf-pick-${i}`]!.fire('click');
        page.el['sf-email']!.value = `buyer${i}@gmail.com`;
        page.el['sf-form']!.fire('submit');
        await vi.waitFor(() => expect(page.requests).toHaveLength(i + 1));
        await vi.waitFor(() => expect(page.el['sf-result']!.classList.contains('hidden')).toBe(false));
      }
      const secondCode = page.el['sf-code']!.textContent;
      page.el['sf-go']!.fire('click');
      await vi.waitFor(() => expect(page.navigations).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(page.navigations).toHaveLength(1); // one handler, not one per coupon
      expect(page.navigations[0]).toContain(`discount=${secondCode}`);
    });

    it('shows a friendly error when the buyer is rate-limited', async () => {
      const ip = '189.200.45.99';
      const html = (await app.inject({ method: 'GET', url: '/c/leo' })).body;
      const productId = (await app.inject({ method: 'GET', url: '/v1/storefronts/leo' })).json().products[0].product_id;
      for (let i = 0; i < 5; i++) await requestCoupon(productId, { email: `r${i}@gmail.com` }, ip);
      const page = bootStorefront(html, app, ip);
      page.el['sf-pick-0']!.fire('click');
      page.el['sf-email']!.value = 'late@gmail.com';
      page.el['sf-form']!.fire('submit');
      await vi.waitFor(() => expect(page.el['sf-error']!.textContent).toBe('Demasiados intentos desde tu red. Intenta más tarde.'));
    });
  });
});

// ---------- Minimal DOM harness for the storefront's real inline script ----------

class FakeElement {
  value = '';
  textContent = '';
  disabled = false;
  checked = false;
  style: Record<string, string> = {};
  private attrs: Record<string, string> = {};
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  private classes: Set<string>;
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  constructor(classes: string[] = []) {
    this.classes = new Set(classes);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string): boolean {
    let prevented = false;
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault: () => (prevented = true) });
    return prevented;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  focus() {}
  select() {}
}

function bootStorefront(html: string, app: FastifyInstance, ip: string) {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const config = /<script type="application\/json" id="sf-config">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const items = (JSON.parse(config) as { items: unknown[] }).items;

  const el: Record<string, FakeElement> = {};
  for (const id of ['sf-form', 'sf-submit', 'sf-error', 'sf-phone', 'sf-wa', 'sf-email', 'sf-code', 'sf-go', 'sf-copy', 'sf-timer', 'sf-selected-name']) {
    el[id] = new FakeElement();
  }
  el['sf-request'] = new FakeElement(['hidden']);
  el['sf-result'] = new FakeElement(['hidden']);
  el['sf-config'] = Object.assign(new FakeElement(), { textContent: config });
  items.forEach((_item, i) => (el[`sf-pick-${i}`] = new FakeElement()));

  const clipboard: string[] = [];
  const navigations: string[] = [];
  const requests: { url: string; body: unknown }[] = [];

  runInNewContext(script, {
    JSON,
    Date,
    Math,
    Promise,
    setTimeout,
    setInterval: () => 1,
    clearInterval: () => undefined,
    encodeURIComponent,
    document: {
      getElementById: (id: string) => el[id] ?? null,
      createElement: () => new FakeElement(),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => true,
    },
    navigator: { userAgent: 'vitest', clipboard: { writeText: async (t: string) => void clipboard.push(t) } },
    window: { isSecureContext: true, location: { assign: (u: string) => void navigations.push(u) } },
    fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      requests.push({ url, body: JSON.parse(init.body) });
      const res = await app.inject({ method: init.method as 'POST', url, headers: init.headers, payload: init.body, remoteAddress: ip });
      return { status: res.statusCode, json: async () => res.json() };
    },
  });

  return { el, clipboard, navigations, requests };
}
