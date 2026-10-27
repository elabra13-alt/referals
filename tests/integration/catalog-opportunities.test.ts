import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { creators, links, sellers } from '../../src/db/schema.js';
import { creatorStorefrontItems } from '../../src/db/schema/storefront.js';
import { HooksGenerator, catalogCategoryOf } from '../../src/modules/catalog/hooks-generator.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedAuthenticatedSeller, seedCreator } from '../helpers.js';

type Seller = Awaited<ReturnType<typeof seedAuthenticatedSeller>>;
type Creator = Awaited<ReturnType<typeof seedCreator>>;

describe('Open Catalog: discovery & 1-click join', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let alice: Seller;
  let bob: Seller;
  let leo: Creator; // unverified
  let vera: Creator; // verified

  /** Product + campaign through the seller API. */
  const createOpportunity = async (
    seller: Seller,
    opts: { name: string; category?: string; price?: number; rate?: number; isPublic?: boolean; verifiedOnly?: boolean; status?: 'active' | 'paused' },
  ) => {
    const product = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: seller.authHeaders,
      payload: {
        name: opts.name,
        price: opts.price ?? 1000,
        margin: 100,
        checkout_base_url: 'https://shop.example.mx/checkout',
        category: opts.category ?? 'beauty',
      },
    });
    expect(product.statusCode).toBe(201);
    const campaign = await app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: seller.authHeaders,
      payload: {
        product_id: product.json().id,
        commission_rate: opts.rate ?? 0.15,
        status: opts.status ?? 'active',
        is_public_catalog: opts.isPublic ?? true,
        requires_verified_creator: opts.verifiedOnly ?? false,
      },
    });
    expect(campaign.statusCode).toBe(201);
    clock.advance(1000); // distinct created_at for "newest" ordering
    return { productId: product.json().id as string, campaignId: campaign.json().id as string };
  };

  const list = async (creator: Creator, query = '') => {
    const res = await app.inject({ method: 'GET', url: `/v1/catalog/opportunities${query}`, headers: creator.authHeaders });
    expect(res.statusCode).toBe(200);
    return res.json().data as { campaign_id: string; product: { name: string }; [k: string]: unknown }[];
  };

  const join = (creator: Creator, campaignId: string) =>
    app.inject({ method: 'POST', url: `/v1/catalog/opportunities/${campaignId}/join`, headers: creator.authHeaders });

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-26T18:00:00.000Z'));
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, now: clock.now, generatorOptions: { now: clock.now } },
      { logger: false },
    );
    alice = await seedAuthenticatedSeller(db, 'Alice Beauty');
    bob = await seedAuthenticatedSeller(db, 'Bob Gadgets');
    leo = await seedCreator(db, { slug: 'LEO', name: 'Leo Mendez', handle: '@soyleomx' });
    vera = await seedCreator(db, { slug: 'VERA', email: 'vera@creators.mx', isVerified: true });
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  describe('GET /v1/catalog/opportunities', () => {
    it('lists only public, active campaigns on active products of active sellers', async () => {
      const open = await createOpportunity(alice, { name: 'Sérum Abierto' });
      await createOpportunity(alice, { name: 'Sérum Privado', isPublic: false });
      await createOpportunity(alice, { name: 'Sérum Pausado', status: 'paused' });
      const archived = await createOpportunity(alice, { name: 'Sérum Archivado' });
      await app.inject({ method: 'DELETE', url: `/v1/products/${archived.productId}`, headers: alice.authHeaders });
      await createOpportunity(bob, { name: 'Audífonos de Bob', category: 'audio' });
      await db.update(sellers).set({ status: 'suspended' }).where(eq(sellers.id, bob.seller.id));

      expect((await list(leo)).map((o) => o.campaign_id)).toEqual([open.campaignId]);
    });

    it('returns brand, catalog category, commission terms and escrow days — but no seller internals', async () => {
      const o = await createOpportunity(alice, { name: 'Glow Serum', price: 649, rate: 0.15 });
      const res = await app.inject({ method: 'GET', url: '/v1/catalog/opportunities', headers: leo.authHeaders });
      expect(res.json()).toEqual({
        data: [
          {
            campaign_id: o.campaignId,
            product: { id: o.productId, name: 'Glow Serum', price: '649.00', currency: 'MXN', category: 'beauty' },
            brand: { name: 'Alice Beauty' },
            catalog_category: 'beauty_skincare',
            commission_rate: '0.1500',
            estimated_commission_per_sale: '97.35',
            escrow_days: 14,
            requires_verified_creator: false,
            eligible: true,
            joined: false,
            link_slug: null,
          },
        ],
        limit: 20,
        offset: 0,
      });
      for (const internal of ['platform_fee', 'margin', 'checkout', 'seller_id', 'webhook']) expect(res.body).not.toContain(internal);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it.each([
      ['beauty', 'beauty_skincare', 14],
      ['skincare', 'beauty_skincare', 14],
      ['consumables', 'beauty_skincare', 14],
      ['home', 'general', 21],
      ['toys', 'general', 21],
      ['electronics', 'electronics', 25],
      ['audio', 'electronics', 25],
      ['fashion', 'fashion', 28],
      ['footwear', 'fashion', 28],
      ['apparel', 'fashion', 28],
    ])('maps product category %s → catalog %s with %i escrow days', async (category, bucket, days) => {
      await createOpportunity(alice, { name: `Producto ${category}`, category });
      const [o] = await list(leo);
      expect(o).toMatchObject({ catalog_category: bucket, escrow_days: days });
    });

    it('filters by catalog category, including the "general" catch-all', async () => {
      await createOpportunity(alice, { name: 'Sérum', category: 'beauty' });
      await createOpportunity(alice, { name: 'FPS', category: 'skincare' });
      await createOpportunity(alice, { name: 'Tenis', category: 'footwear' });
      await createOpportunity(alice, { name: 'Bocina', category: 'audio' });
      await createOpportunity(alice, { name: 'Lámpara', category: 'home' });
      await createOpportunity(alice, { name: 'Peluche', category: 'toys' });
      const names = async (category: string) => (await list(leo, `?category=${category}`)).map((o) => o.product.name).sort();
      expect(await names('beauty_skincare')).toEqual(['FPS', 'Sérum']);
      expect(await names('fashion')).toEqual(['Tenis']);
      expect(await names('electronics')).toEqual(['Bocina']);
      expect(await names('general')).toEqual(['Lámpara', 'Peluche']);
    });

    it('searches product and brand names, case-insensitively, treating wildcards literally', async () => {
      await createOpportunity(alice, { name: 'Sérum Glow 100% Natural' });
      await createOpportunity(alice, { name: 'Crema Nocturna' });
      await createOpportunity(bob, { name: 'Audífonos Pro', category: 'audio' });
      const names = async (q: string) => (await list(leo, `?q=${encodeURIComponent(q)}`)).map((o) => o.product.name).sort();
      expect(await names('glow')).toEqual(['Sérum Glow 100% Natural']);
      expect(await names('bob gadgets')).toEqual(['Audífonos Pro']); // brand search
      expect(await names('100%')).toEqual(['Sérum Glow 100% Natural']);
      expect(await names('%')).toEqual(['Sérum Glow 100% Natural']); // not "match everything"
      expect(await names('_')).toEqual([]);
    });

    it('sorts by expected payout (default), by commission rate, or by newest', async () => {
      const cheapHighRate = await createOpportunity(alice, { name: 'A', price: 100, rate: 0.5 }); // pays 50
      const priceyLowRate = await createOpportunity(alice, { name: 'B', price: 2000, rate: 0.1 }); // pays 200
      const middle = await createOpportunity(alice, { name: 'C', price: 600, rate: 0.2 }); // pays 120
      const ids = async (q: string) => (await list(leo, q)).map((o) => o.campaign_id);
      expect(await ids('')).toEqual([priceyLowRate.campaignId, middle.campaignId, cheapHighRate.campaignId]);
      expect(await ids('?sort=commission_rate')).toEqual([cheapHighRate.campaignId, middle.campaignId, priceyLowRate.campaignId]);
      expect(await ids('?sort=newest')).toEqual([middle.campaignId, priceyLowRate.campaignId, cheapHighRate.campaignId]);
      expect(await ids('?limit=1&offset=1')).toEqual([middle.campaignId]);
    });

    it('marks verified-only campaigns as not eligible for unverified creators', async () => {
      await createOpportunity(alice, { name: 'Premium', verifiedOnly: true });
      expect((await list(leo))[0]).toMatchObject({ requires_verified_creator: true, eligible: false });
      expect((await list(vera))[0]).toMatchObject({ requires_verified_creator: true, eligible: true });
    });

    it('requires a creator API key and validates the query', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/catalog/opportunities' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/v1/catalog/opportunities', headers: alice.authHeaders })).statusCode).toBe(401);
      for (const q of ['?category=cars', '?sort=random', '?limit=500']) {
        expect((await app.inject({ method: 'GET', url: `/v1/catalog/opportunities${q}`, headers: leo.authHeaders })).statusCode).toBe(400);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /v1/catalog/opportunities/:campaignId/join', () => {
    it('creates the referral link and storefront card atomically and returns 3 structured hooks', async () => {
      const o = await createOpportunity(alice, { name: 'Glow Serum', price: 649, rate: 0.15 });
      const res = await join(leo, o.campaignId);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        status: 'joined',
        campaign_id: o.campaignId,
        link: { campaign_id: o.campaignId, creator_slug: 'LEO', link_slug: 'leo-glow-serum', url: 'https://referals.mx/r/leo-glow-serum', status: 'active' },
        storefront: { url: 'https://referals.mx/c/leo' },
        commission_rate: '0.1500',
        estimated_commission_per_sale: '97.35',
        escrow_days: 14,
      });

      // Hooks: exactly three, one per angle, distinct, about this product.
      expect(body.hooks.category).toBe('beauty_skincare');
      expect(body.hooks.hooks.map((h: { angle: string }) => h.angle)).toEqual(['problema', 'prueba', 'oferta']);
      expect(new Set(body.hooks.hooks.map((h: { hook: string }) => h.hook)).size).toBe(3);
      expect(body.hooks.hooks.slice(1).every((h: { hook: string }) => h.hook.includes('Glow Serum'))).toBe(true);
      expect(body.hooks.hooks[2].hook).toMatch(/48 horas|al instante/);
      expect(body.hooks.disclosure).toBe('#Publicidad #Colaboración');

      const [link] = await db.select().from(links);
      expect(link).toMatchObject({ creatorId: leo.id, influencerSlug: 'LEO', linkSlug: 'leo-glow-serum' });
      expect(link!.customScript).toContain('[HOOK]');
      const [item] = await db.select().from(creatorStorefrontItems);
      expect(item).toMatchObject({ id: body.storefront.item_id, creatorId: leo.id, productId: o.productId, campaignId: o.campaignId, linkId: link!.id, isActive: true });
    });

    it('is idempotent: joining again returns the same link and never duplicates', async () => {
      const o = await createOpportunity(alice, { name: 'Glow Serum' });
      const first = (await join(leo, o.campaignId)).json();
      const again = await join(leo, o.campaignId);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ status: 'already_joined', link: { id: first.link.id }, storefront: { item_id: first.storefront.item_id } });
      expect(await db.select().from(links)).toHaveLength(1);
      expect(await db.select().from(creatorStorefrontItems)).toHaveLength(1);
      expect((await list(leo))[0]).toMatchObject({ joined: true, link_slug: 'leo-glow-serum' });
    });

    it('converges concurrent double-clicks on a single link and card', async () => {
      const o = await createOpportunity(alice, { name: 'Glow Serum' });
      const results = await Promise.all([join(leo, o.campaignId), join(leo, o.campaignId), join(leo, o.campaignId)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
      expect(new Set(results.map((r) => r.json().link.id)).size).toBe(1);
      expect(await db.select().from(links)).toHaveLength(1);
      expect(await db.select().from(creatorStorefrontItems)).toHaveLength(1);
    });

    it('gates verified-only campaigns (403) and lets verified creators in', async () => {
      const o = await createOpportunity(alice, { name: 'Premium', verifiedOnly: true });
      const denied = await join(leo, o.campaignId);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('VERIFIED_CREATOR_REQUIRED');
      expect(await db.select().from(links)).toHaveLength(0);

      expect((await join(vera, o.campaignId)).statusCode).toBe(201);
      await db.update(creators).set({ isVerified: true }).where(eq(creators.id, leo.id));
      expect((await join(leo, o.campaignId)).statusCode).toBe(201);
    });

    it.each([
      ['a private campaign', { isPublic: false }],
      ['a paused campaign', { status: 'paused' as const }],
    ])('404s for %s (no enumeration)', async (_label, opts) => {
      const o = await createOpportunity(bob, { name: 'Oculto', ...opts });
      const res = await join(leo, o.campaignId);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('OPPORTUNITY_NOT_FOUND');
      expect(await db.select().from(links)).toHaveLength(0);
    });

    it('404s for unknown and malformed campaign ids, and requires a creator key', async () => {
      expect((await join(leo, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
      expect((await join(leo, 'not-a-uuid')).statusCode).toBe(404);
      const o = await createOpportunity(alice, { name: 'Glow Serum' });
      expect((await app.inject({ method: 'POST', url: `/v1/catalog/opportunities/${o.campaignId}/join` })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `/v1/catalog/opportunities/${o.campaignId}/join`, headers: alice.authHeaders })).statusCode).toBe(401);
    });

    it('puts the product on the public storefront, where buyers can get a live coupon', async () => {
      const o = await createOpportunity(alice, { name: 'Glow Serum' });
      await join(leo, o.campaignId);
      const storefront = (await app.inject({ method: 'GET', url: '/v1/storefronts/leo' })).json();
      expect(storefront.products).toEqual([expect.objectContaining({ product_id: o.productId, link_slug: 'leo-glow-serum' })]);

      const coupon = await app.inject({
        method: 'POST',
        url: `/v1/storefronts/leo/products/${o.productId}/coupons`,
        payload: { buyer: { email: 'valeria@gmail.com' } },
        remoteAddress: '10.60.0.1',
      });
      expect(coupon.statusCode).toBe(201);
      expect(coupon.json().code).toMatch(/^REF-LEO-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    });

    it('re-joining re-activates a hidden storefront card but keeps the creator’s own curation', async () => {
      const o = await createOpportunity(alice, { name: 'Glow Serum' });
      const joined = (await join(leo, o.campaignId)).json();
      await app.inject({
        method: 'PATCH',
        url: `/v1/creators/me/storefront/items/${joined.storefront.item_id}`,
        headers: leo.authHeaders,
        payload: { is_active: false, is_featured: true, custom_hook_text: 'Mi favorito', display_order: 7 },
      });
      await join(leo, o.campaignId);
      const [item] = await db.select().from(creatorStorefrontItems);
      expect(item).toMatchObject({ isActive: true, isFeatured: true, customHookText: 'Mi favorito', displayOrder: 7 });
    });

    it('joining a second campaign for the same product re-points the card to the new link', async () => {
      const first = await createOpportunity(alice, { name: 'Glow Serum', rate: 0.1 });
      await join(leo, first.campaignId);
      const second = await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        headers: alice.authHeaders,
        payload: { product_id: first.productId, commission_rate: 0.2, is_public_catalog: true },
      });
      const res = await join(leo, second.json().id);
      expect(res.statusCode).toBe(201);
      expect(res.json().link.link_slug).toMatch(/^leo-glow-serum-[23456789abcdefghjkmnpqrstvwxyz]{4}$/);
      const items = await db.select().from(creatorStorefrontItems);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ campaignId: second.json().id, linkId: res.json().link.id });
    });
  });

  // ---------------------------------------------------------------------------
  describe('seller controls', () => {
    it('sellers open and close campaigns to the catalog; other sellers cannot touch them', async () => {
      const o = await createOpportunity(alice, { name: 'Glow Serum', isPublic: false });
      const campaign = await app.inject({ method: 'GET', url: `/v1/campaigns/${o.campaignId}`, headers: alice.authHeaders });
      expect(campaign.json()).toMatchObject({ is_public_catalog: false, requires_verified_creator: false });
      expect(await list(leo)).toHaveLength(0);

      const foreign = await app.inject({ method: 'PATCH', url: `/v1/campaigns/${o.campaignId}`, headers: bob.authHeaders, payload: { is_public_catalog: true } });
      expect(foreign.statusCode).toBe(404);
      expect(await list(leo)).toHaveLength(0);

      const opened = await app.inject({ method: 'PATCH', url: `/v1/campaigns/${o.campaignId}`, headers: alice.authHeaders, payload: { is_public_catalog: true } });
      expect(opened.json()).toMatchObject({ is_public_catalog: true });
      expect(await list(leo)).toHaveLength(1);

      await app.inject({ method: 'PATCH', url: `/v1/campaigns/${o.campaignId}`, headers: alice.authHeaders, payload: { is_public_catalog: false } });
      expect(await list(leo)).toHaveLength(0);
      expect((await join(leo, o.campaignId)).statusCode).toBe(404);
    });
  });
});

describe('HooksGenerator', () => {
  const gen = new HooksGenerator();

  it.each([
    ['beauty', 'beauty_skincare'],
    ['footwear', 'fashion'],
    ['audio', 'electronics'],
    ['home', 'general'],
  ])('gives 3 distinct, deterministic hooks for %s (%s)', (category, bucket) => {
    const a = gen.generate({ creatorSlug: 'LEO', productName: 'Producto X', productCategory: category });
    expect(a.category).toBe(bucket);
    expect(a.hooks).toHaveLength(3);
    expect(new Set(a.hooks.map((h) => h.angle))).toEqual(new Set(['problema', 'prueba', 'oferta']));
    expect(new Set(a.hooks.map((h) => h.hook)).size).toBe(3);
    for (const h of a.hooks) {
      expect(h.hook.length).toBeGreaterThan(20);
      expect(h.on_screen_text.length).toBeLessThanOrEqual(40);
      expect(h.hook).not.toContain('{product}');
      expect(h.hook).not.toMatch(/\d+\s*%/); // never invents a discount percentage
    }
    expect(gen.generate({ creatorSlug: 'LEO', productName: 'Producto X', productCategory: category })).toEqual(a);
  });

  it('maps unknown product categories to the general bucket', () => {
    expect(catalogCategoryOf('Mascotas')).toBe('general');
  });
});
