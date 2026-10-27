import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { campaignInvitations, campaigns, creators, links, products } from '../../src/db/schema.js';
import { creatorStorefrontItems } from '../../src/db/schema/storefront.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedAuthenticatedSeller, seedCreator } from '../helpers.js';

type Seller = Awaited<ReturnType<typeof seedAuthenticatedSeller>>;
type Creator = Awaited<ReturnType<typeof seedCreator>>;

const DAY = 24 * 60 * 60 * 1000;

describe('AI matchmaker & campaign invitations', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let alice: Seller;
  let bob: Seller;
  let campaignId: string;
  let productId: string;
  let aaa: Creator; // beauty, 50k, 8% engagement, verified → 100
  let bbb: Creator; // fashion (adjacent) → 80
  let ddd: Creator; // electronics, 2M → 27

  const asSeller = (seller: Seller, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers: seller.authHeaders, ...(payload ? { payload } : {}) });
  const asCreator = (creator: Creator, method: 'GET' | 'POST', url: string) =>
    app.inject({ method, url, headers: creator.authHeaders });

  const invite = (creatorSlug: string, extra: Record<string, unknown> = {}, seller = alice, campaign = campaignId) =>
    asSeller(seller, 'POST', `/v1/campaigns/${campaign}/invitations`, { creator_slug: creatorSlug, ...extra });

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-26T18:00:00.000Z'));
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, now: clock.now, generatorOptions: { now: clock.now } },
      { logger: false },
    );
    alice = await seedAuthenticatedSeller(db, 'Alice Beauty');
    bob = await seedAuthenticatedSeller(db, 'Bob Gadgets');
    const product = await asSeller(alice, 'POST', '/v1/products', {
      name: 'Glow Serum',
      price: 649,
      margin: 200,
      checkout_base_url: 'https://shop.example.mx/checkout',
      category: 'beauty',
    });
    productId = product.json().id;
    // Private campaign: invitations work regardless of the Open Catalog.
    campaignId = (await asSeller(alice, 'POST', '/v1/campaigns', { product_id: productId, commission_rate: 0.15 })).json().id;

    aaa = await seedCreator(db, { slug: 'AAA', niche: 'beauty', followersCount: 50_000, engagementRate: '0.0800', isVerified: true });
    bbb = await seedCreator(db, { slug: 'BBB', email: 'bbb@creators.mx', niche: 'fashion', followersCount: 30_000, engagementRate: '0.0800', speiClabe: null });
    ddd = await seedCreator(db, { slug: 'DDD', email: 'ddd@creators.mx', niche: 'electronics', followersCount: 2_000_000, engagementRate: '0.0200' });
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  describe('seller matchmaker (GET /v1/campaigns/:id/matches)', () => {
    it('ranks creators 0–100 with explainable tags and reasons', async () => {
      const res = await asSeller(alice, 'GET', `/v1/campaigns/${campaignId}/matches`);
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.map((m: { creator: { slug: string }; score: number }) => [m.creator.slug, m.score])).toEqual([
        ['AAA', 100],
        ['BBB', 80],
        ['DDD', 27],
      ]);
      expect(data[0]).toMatchObject({
        tags: ['niche_match', 'high_engagement', 'micro_sweet_spot', 'verified', 'payout_ready'],
        reasons: expect.arrayContaining(['Niche match: beauty']),
        already_linked: false,
        invitation: null,
      });
      expect(data[1].tags).toEqual(['adjacent_audience', 'high_engagement', 'micro_sweet_spot']);
      expect(data[2].tags).toEqual(['macro_reach', 'payout_ready']);
      for (const m of data) expect(m.score).toBeGreaterThanOrEqual(0), expect(m.score).toBeLessThanOrEqual(100);
    });

    it('shows each creator’s invitation status and link state', async () => {
      await invite('AAA');
      await invite('BBB');
      await asCreator(bbb, 'POST', `/v1/creators/me/invitations/${(await asCreator(bbb, 'GET', '/v1/creators/me/invitations')).json().data[0].id}/accept`);
      const data = (await asSeller(alice, 'GET', `/v1/campaigns/${campaignId}/matches`)).json().data;
      const by = (slug: string) => data.find((m: { creator: { slug: string } }) => m.creator.slug === slug);
      expect(by('AAA')).toMatchObject({ already_linked: false, invitation: { status: 'pending', expires_at: '2026-11-02T18:00:00.000Z' } });
      expect(by('BBB')).toMatchObject({ already_linked: true, invitation: { status: 'accepted' } });
      expect(by('DDD')).toMatchObject({ invitation: null });
    });

    it('is tenant-scoped (404 for another seller’s campaign) and never leaks creator PII', async () => {
      expect((await asSeller(bob, 'GET', `/v1/campaigns/${campaignId}/matches`)).statusCode).toBe(404);
      const body = (await asSeller(alice, 'GET', `/v1/campaigns/${campaignId}/matches`)).body;
      expect(body).not.toContain('@creators.mx');
      expect(body).not.toContain('002010077777777771');
    });
  });

  // ---------------------------------------------------------------------------
  describe('seller invitations (POST/GET /v1/campaigns/:id/invitations)', () => {
    it('invites a creator with a match snapshot and a 7-day window', async () => {
      const res = await invite('aaa', { custom_note: '¡Nos encantó tu contenido de skincare!' });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        campaign_id: campaignId,
        creator: { slug: 'AAA' },
        status: 'pending',
        match_score: 100,
        match_reason: expect.stringContaining('Niche match: beauty'),
        tags: expect.arrayContaining(['niche_match']),
        custom_note: '¡Nos encantó tu contenido de skincare!',
        expires_at: '2026-11-02T18:00:00.000Z',
        responded_at: null,
      });
      const [row] = await db.select().from(campaignInvitations);
      expect(row).toMatchObject({ sellerId: alice.seller.id, creatorId: aaa.id, matchScore: 100, status: 'pending' });

      const list = (await asSeller(alice, 'GET', `/v1/campaigns/${campaignId}/invitations`)).json();
      expect(list.data).toEqual([expect.objectContaining({ id: res.json().id, status: 'pending' })]);
    });

    it('refuses a second pending invitation (409 with the existing one)', async () => {
      const first = (await invite('AAA')).json();
      const again = await invite('AAA');
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toMatchObject({ code: 'INVITATION_PENDING', details: { invitation: { id: first.id } } });
      expect(await db.select().from(campaignInvitations)).toHaveLength(1);
    });

    it('re-sends an expired invitation on the same row with a fresh window and score', async () => {
      const first = (await invite('AAA')).json();
      clock.advance(8 * DAY);
      expect((await asSeller(alice, 'GET', `/v1/campaigns/${campaignId}/invitations`)).json().data[0].status).toBe('expired');
      const resent = await invite('AAA', { custom_note: 'Segunda oportunidad' });
      expect(resent.statusCode).toBe(201);
      expect(resent.json()).toMatchObject({ id: first.id, status: 'pending', custom_note: 'Segunda oportunidad', expires_at: '2026-11-10T18:00:00.000Z' });
      expect(await db.select().from(campaignInvitations)).toHaveLength(1);
    });

    it('respects a decline: no re-inviting', async () => {
      const inv = (await invite('AAA')).json();
      await asCreator(aaa, 'POST', `/v1/creators/me/invitations/${inv.id}/decline`);
      const again = await invite('AAA');
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('INVITATION_DECLINED');
    });

    it.each([
      ['an unknown creator', 'ZZZ', 404, 'CREATOR_NOT_FOUND'],
      ['a malformed slug', 'a!', 400, 'VALIDATION_ERROR'],
    ])('rejects %s', async (_label, slug, status, code) => {
      const res = await invite(slug);
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(code);
    });

    it('rejects suspended creators, creators already on the campaign, and inactive campaigns', async () => {
      await db.update(creators).set({ status: 'suspended' }).where(eq(creators.id, ddd.id));
      expect((await invite('DDD')).json().error.code).toBe('CREATOR_SUSPENDED');

      await asSeller(alice, 'POST', `/v1/campaigns/${campaignId}/links`, { creator_slug: 'BBB' });
      expect((await invite('BBB')).json().error.code).toBe('ALREADY_JOINED');

      await db.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, campaignId));
      const paused = await invite('AAA');
      expect(paused.statusCode).toBe(409);
      expect(paused.json().error.code).toBe('CAMPAIGN_NOT_ACTIVE');
    });

    it('is tenant-scoped: other sellers can neither invite to nor list someone else’s campaign', async () => {
      expect((await invite('AAA', {}, bob)).statusCode).toBe(404);
      expect((await asSeller(bob, 'GET', `/v1/campaigns/${campaignId}/invitations`)).statusCode).toBe(404);
      expect(await db.select().from(campaignInvitations)).toHaveLength(0);
    });

    it('validates the note and requires seller auth', async () => {
      expect((await invite('AAA', { custom_note: 'x'.repeat(501) })).statusCode).toBe(400);
      expect((await invite('AAA', { campaign_id: campaignId })).statusCode).toBe(400);
      expect((await asCreator(aaa, 'POST', `/v1/campaigns/${campaignId}/invitations`)).statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('creator inbox (GET /v1/creators/me/invitations)', () => {
    it('shows earnings in $ MXN, brand, product, escrow and 3 hooks for pending invitations', async () => {
      const inv = (await invite('AAA', { custom_note: 'Hola Ana' })).json();
      const res = await asCreator(aaa, 'GET', '/v1/creators/me/invitations');
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const [item] = res.json().data;
      expect(item).toMatchObject({
        id: inv.id,
        status: 'pending',
        can_accept: true,
        brand: { name: 'Alice Beauty' },
        product: { id: productId, name: 'Glow Serum', price: '649.00', currency: 'MXN', category: 'beauty' },
        commission_rate: '0.1500',
        estimated_earnings_per_sale: '97.35',
        escrow_days: 14,
        match_score: 100,
        custom_note: 'Hola Ana',
        expires_at: '2026-11-02T18:00:00.000Z',
      });
      expect(item.hooks.hooks.map((h: { angle: string }) => h.angle)).toEqual(['problema', 'prueba', 'oferta']);
      expect(res.body).not.toContain('platform_fee');
    });

    it('is private to each creator and hides history unless asked', async () => {
      const inv = (await invite('AAA')).json();
      expect((await asCreator(bbb, 'GET', '/v1/creators/me/invitations')).json().data).toEqual([]);
      await asCreator(aaa, 'POST', `/v1/creators/me/invitations/${inv.id}/decline`);
      expect((await asCreator(aaa, 'GET', '/v1/creators/me/invitations')).json().data).toEqual([]);
      expect((await asCreator(aaa, 'GET', '/v1/creators/me/invitations?status=declined')).json().data).toHaveLength(1);
      expect((await asCreator(aaa, 'GET', '/v1/creators/me/invitations?status=all')).json().data).toHaveLength(1);
      expect((await asCreator(aaa, 'GET', '/v1/creators/me/invitations?status=bogus')).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/v1/creators/me/invitations', headers: alice.authHeaders })).statusCode).toBe(401);
    });

    it('moves invitations past their 7-day window to "expired"', async () => {
      await invite('AAA');
      clock.advance(7 * DAY);
      expect((await asCreator(aaa, 'GET', '/v1/creators/me/invitations')).json().data).toEqual([]);
      expect((await asCreator(aaa, 'GET', '/v1/creators/me/invitations?status=expired')).json().data).toEqual([
        expect.objectContaining({ status: 'expired', can_accept: false }),
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('1-click accept / decline', () => {
    let invitationId: string;

    beforeEach(async () => {
      invitationId = (await invite('AAA')).json().id;
    });

    const accept = (creator = aaa, id = invitationId) => asCreator(creator, 'POST', `/v1/creators/me/invitations/${id}/accept`);

    it('atomically creates the referral link, publishes it to the storefront and marks the invitation accepted', async () => {
      const res = await accept();
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        status: 'accepted',
        invitation: { id: invitationId, status: 'accepted', can_accept: false },
        link: { campaign_id: campaignId, creator_slug: 'AAA', link_slug: 'aaa-glow-serum', status: 'active' },
        storefront: { url: 'https://referals.mx/c/aaa' },
      });

      const [inv] = await db.select().from(campaignInvitations);
      expect(inv).toMatchObject({ status: 'accepted', respondedAt: clock.now() });
      const [link] = await db.select().from(links);
      expect(link).toMatchObject({ creatorId: aaa.id, campaignId, influencerSlug: 'AAA' });
      expect(link!.customScript).toContain('[HOOK]');
      const [item] = await db.select().from(creatorStorefrontItems);
      expect(item).toMatchObject({ id: body.storefront.item_id, creatorId: aaa.id, productId, campaignId, linkId: link!.id, isActive: true });

      // Live on the public storefront: buyers can get a coupon right away.
      const coupon = await app.inject({
        method: 'POST',
        url: `/v1/storefronts/aaa/products/${productId}/coupons`,
        payload: { buyer: { email: 'valeria@gmail.com' } },
        remoteAddress: '10.70.0.1',
      });
      expect(coupon.statusCode).toBe(201);
      expect(coupon.json().code).toMatch(/^REF-AAA-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    });

    it('is idempotent: accepting twice returns the same link (200)', async () => {
      const first = (await accept()).json();
      const again = await accept();
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ status: 'already_accepted', link: { id: first.link.id } });
      expect(await db.select().from(links)).toHaveLength(1);
      expect(await db.select().from(creatorStorefrontItems)).toHaveLength(1);
    });

    it('converges concurrent accepts on one link', async () => {
      const results = await Promise.all([accept(), accept(), accept()]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
      expect(new Set(results.map((r) => r.json().link.id)).size).toBe(1);
      expect(await db.select().from(links)).toHaveLength(1);
    });

    it('410s once the invitation has expired, and persists the expiry', async () => {
      clock.advance(7 * DAY + 1);
      const res = await accept();
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('INVITATION_EXPIRED');
      expect(await db.select().from(links)).toHaveLength(0);
      const [inv] = await db.select().from(campaignInvitations);
      expect(inv!.status).toBe('expired');
    });

    it('410s when the campaign or product closed after inviting', async () => {
      await db.update(products).set({ status: 'paused' }).where(eq(products.id, productId));
      expect((await asCreator(aaa, 'GET', '/v1/creators/me/invitations')).json().data[0].can_accept).toBe(false);
      const res = await accept();
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('CAMPAIGN_NOT_ACTIVE');
      expect(await db.select().from(links)).toHaveLength(0);
    });

    it('declines (idempotently), after which accepting is refused', async () => {
      const declined = await asCreator(aaa, 'POST', `/v1/creators/me/invitations/${invitationId}/decline`);
      expect(declined.statusCode).toBe(200);
      expect(declined.json()).toMatchObject({ status: 'declined', can_accept: false });
      expect((await asCreator(aaa, 'POST', `/v1/creators/me/invitations/${invitationId}/decline`)).statusCode).toBe(200);

      const res = await accept();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('INVITATION_DECLINED');
      const [inv] = await db.select().from(campaignInvitations);
      expect(inv).toMatchObject({ status: 'declined', respondedAt: clock.now() });
    });

    it('cannot decline after accepting', async () => {
      await accept();
      const res = await asCreator(aaa, 'POST', `/v1/creators/me/invitations/${invitationId}/decline`);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });

    it('scopes invitations to their creator (404 for anyone else) and validates ids', async () => {
      expect((await accept(bbb)).statusCode).toBe(404);
      expect((await asCreator(bbb, 'POST', `/v1/creators/me/invitations/${invitationId}/decline`)).statusCode).toBe(404);
      expect((await accept(aaa, 'not-a-uuid')).statusCode).toBe(404);
      expect((await accept(aaa, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
      const [inv] = await db.select().from(campaignInvitations);
      expect(inv!.status).toBe('pending');
    });
  });
});
