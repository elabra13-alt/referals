import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';
import { creators, ledgerEntries, links } from '../src/db/schema.js';
import { clabeCheckDigit, isValidClabe, maskClabe } from '../src/lib/clabe.js';
import { hashApiKey } from '../src/lib/keys.js';
import { EscrowWorkerService } from '../src/modules/escrow/escrow-worker.service.js';
import { MatchingService, nicheAffinity, reachScore } from '../src/modules/creators/matching.service.js';
import { TemplateScriptGenerator, buildScriptPrompt, type ScriptContext } from '../src/modules/creators/script-generator.service.js';
import { slugify } from '../src/modules/creators/creators.service.js';
import { signPayload } from '../src/modules/webhooks/signature.js';
import {
  TEST_ENCRYPTION_KEY,
  TestClock,
  createTestDb,
  createTestRedis,
  seedAuthenticatedSeller,
  seedCreator,
} from './helpers.js';

const ADMIN_TOKEN = 'adm_'.padEnd(40, 'x');
const ADMIN = { 'x-referals-admin-token': ADMIN_TOKEN };
const LINK_BASE = 'https://go.referals.test/r';
const VALID_CLABE = '002010077777777771';
const DAY = 24 * 60 * 60 * 1000;

describe('CLABE validation', () => {
  it.each(['002010077777777771', '032180000118359719', '014027000005555558'])('accepts published valid CLABE %s', (c) => {
    expect(isValidClabe(c)).toBe(true);
  });

  it.each([
    ['wrong check digit', '002010077777777772'],
    ['17 digits', '00201007777777777'],
    ['letters', '00201007777777777A'],
  ])('rejects %s', (_label, c) => expect(isValidClabe(c)).toBe(false));

  it('computes the 3-7-1 check digit and masks all but the last 4', () => {
    expect(clabeCheckDigit('03218000011835971')).toBe(9);
    expect(maskClabe('032180000118359719')).toBe('**************9719');
  });
});

describe('MatchingService', () => {
  const svc = new MatchingService();

  it('scores niche, engagement and reach with fixed weights', () => {
    expect(svc.score('beauty', { slug: 'A', niche: 'beauty', followersCount: 50_000, engagementRate: '0.0800' }).score).toBe(100);
    expect(svc.score('beauty', { slug: 'B', niche: 'fashion', followersCount: 30_000, engagementRate: '0.0800' }).score).toBe(80);
    expect(svc.score('skincare', { slug: 'C', niche: 'general', followersCount: 20_000, engagementRate: '0.0400' }).score).toBe(60);
    expect(svc.score('beauty', { slug: 'D', niche: 'electronics', followersCount: 2_000_000, engagementRate: '0.0200' }).score).toBe(27);
  });

  it('maps categories onto niches and keeps affinity symmetric', () => {
    expect(nicheAffinity('footwear', 'fashion')).toBe(1);
    expect(nicheAffinity('audio', 'electronics')).toBe(1);
    expect(nicheAffinity('beauty', 'fashion')).toBe(nicheAffinity('fashion', 'beauty'));
    expect(nicheAffinity('mystery', 'beauty')).toBe(0.5); // unknown category -> general
  });

  it('favours the 10k–100k microinfluencer sweet spot', () => {
    expect(reachScore(0)).toBe(0);
    expect(reachScore(1_000)).toBeCloseTo(0.5);
    expect(reachScore(10_000)).toBe(1);
    expect(reachScore(100_000)).toBe(1);
    expect(reachScore(1_000_000)).toBeCloseTo(0.6);
    expect(reachScore(50_000_000)).toBe(0.6);
    expect(reachScore(5_000)).toBeGreaterThan(reachScore(500));
  });
});

describe('TemplateScriptGenerator', () => {
  const ctx: ScriptContext = {
    creator: { name: 'Leo', handle: '@soyleomx', slug: 'LEO', niche: 'beauty' },
    product: { name: 'Glow Serum', category: 'skincare', price: '499.00', currency: 'MXN' },
    linkUrl: 'https://go.referals.test/r/leo-glow-serum',
  };

  it('produces Hook / Agitation / Solution / CTA with the product, link and disclosure', async () => {
    const script = await new TemplateScriptGenerator().generate(ctx);
    expect(script.engine).toBe('template-v1');
    for (const part of [script.hook, script.agitation, script.solution, script.cta]) expect(part.length).toBeGreaterThan(10);
    expect(script.solution).toContain('Glow Serum');
    expect(script.cta).toContain(ctx.linkUrl);
    expect(script.cta).toContain('48 horas');
    expect(script.full_text.split('\n')).toEqual([
      `[HOOK] ${script.hook}`,
      `[AGITACIÓN] ${script.agitation}`,
      `[SOLUCIÓN] ${script.solution}`,
      `[CTA] ${script.cta}`,
      '#Publicidad #Colaboración',
    ]);
  });

  it('is deterministic for the same creator and product', async () => {
    const gen = new TemplateScriptGenerator();
    expect(await gen.generate(ctx)).toEqual(await gen.generate(ctx));
  });

  it('builds a structured LLM prompt contract', () => {
    const prompt = buildScriptPrompt(ctx);
    expect(prompt.system).toMatch(/hook, agitation, solution, cta/);
    expect(JSON.parse(prompt.user)).toMatchObject({ product: { name: 'Glow Serum' }, link_url: ctx.linkUrl });
  });

  it('slugifies product names', () => {
    expect(slugify('Sérum Glow 2.0!')).toBe('serum-glow-2-0');
  });
});

describe('Creators API', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let alice: Awaited<ReturnType<typeof seedAuthenticatedSeller>>;
  let bob: Awaited<ReturnType<typeof seedAuthenticatedSeller>>;

  const call = (headers: Record<string, string>, method: InjectOptions['method'], url: string, payload?: object) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

  const registerBody = (overrides: Record<string, unknown> = {}) => ({
    name: 'Leo Martínez',
    handle: '@SoyLeoMx',
    email: 'Leo@Creators.MX',
    niche: 'beauty',
    followers_count: 42_000,
    engagement_rate: 0.055,
    spei_clabe: VALID_CLABE,
    ...overrides,
  });

  /** Product + active campaign owned by `seller`, via the public API. */
  const setupCampaign = async (seller = alice, product: Record<string, unknown> = {}) => {
    const p = await call(seller.authHeaders, 'POST', '/v1/products', {
      name: 'Glow Serum',
      price: 1020,
      margin: 300,
      checkout_base_url: 'https://shop.example.mx/checkout',
      category: 'beauty',
      ...product,
    });
    const c = await call(seller.authHeaders, 'POST', '/v1/campaigns', { product_id: p.json().id, commission_rate: 0.15 });
    return { productId: p.json().id as string, campaignId: c.json().id as string };
  };

  const issueLink = (campaignId: string, body: Record<string, unknown>, seller = alice) =>
    call(seller.authHeaders, 'POST', `/v1/campaigns/${campaignId}/links`, body);

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-13T16:00:00.000Z'));
    app = buildApp(
      {
        db,
        redis: await createTestRedis(),
        webhookEncryptionKey: TEST_ENCRYPTION_KEY,
        adminApiToken: ADMIN_TOKEN,
        publicLinkBaseUrl: LINK_BASE,
        now: clock.now,
        generatorOptions: { now: clock.now },
      },
      { logger: false },
    );
    alice = await seedAuthenticatedSeller(db, 'Alice Beauty');
    bob = await seedAuthenticatedSeller(db, 'Bob Gadgets');
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  describe('POST /v1/creators', () => {
    it('registers a creator with normalized fields and a masked CLABE', async () => {
      const res = await call(ADMIN, 'POST', '/v1/creators', registerBody());
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        slug: 'SOYLE', // derived from the handle
        handle: '@soyleomx',
        email: 'leo@creators.mx',
        niche: 'beauty',
        followers_count: 42_000,
        engagement_rate: '0.0550',
        spei_clabe_masked: '**************7771',
        payout_ready: true,
        status: 'active',
      });
      expect(res.body).not.toContain(VALID_CLABE);
    });

    it('accepts an explicit slug and a CLABE with spaces; CLABE is optional', async () => {
      const res = await call(ADMIN, 'POST', '/v1/creators', registerBody({ slug: 'leo', spei_clabe: '002 010 07777777777 1' }));
      expect(res.json()).toMatchObject({ slug: 'LEO', spei_clabe_masked: '**************7771' });

      const noClabe = await call(ADMIN, 'POST', '/v1/creators', registerBody({ slug: 'ANA', email: 'ana@x.mx', spei_clabe: undefined }));
      expect(noClabe.json()).toMatchObject({ spei_clabe_masked: null, payout_ready: false });
    });

    it.each([
      ['bad CLABE check digit', { spei_clabe: '002010077777777772' }],
      ['short CLABE', { spei_clabe: '00201007777777777' }],
      ['unknown niche', { niche: 'cars' }],
      ['engagement above 100%', { engagement_rate: 1.5 }],
      ['negative followers', { followers_count: -1 }],
      ['invalid handle', { handle: '@no spaces' }],
      ['slug too short', { slug: 'AB' }],
      ['unknown field', { status: 'active' }],
    ])('rejects %s with 400', async (_label, overrides) => {
      const res = await call(ADMIN, 'POST', '/v1/creators', registerBody(overrides));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects duplicate emails and slugs with 409', async () => {
      await call(ADMIN, 'POST', '/v1/creators', registerBody({ slug: 'LEO' }));
      const dupEmail = await call(ADMIN, 'POST', '/v1/creators', registerBody({ slug: 'LEO2' }));
      expect(dupEmail.json().error.code).toBe('EMAIL_TAKEN');
      const dupSlug = await call(ADMIN, 'POST', '/v1/creators', registerBody({ slug: 'LEO', email: 'other@x.mx' }));
      expect(dupSlug.statusCode).toBe(409);
      expect(dupSlug.json().error.code).toBe('SLUG_TAKEN');
    });

    it('requires the admin token (seller keys are not enough)', async () => {
      expect((await call({}, 'POST', '/v1/creators', registerBody())).statusCode).toBe(401);
      expect((await call(alice.authHeaders, 'POST', '/v1/creators', registerBody())).statusCode).toBe(401);
    });
  });

  describe('GET /v1/campaigns/:id/matches', () => {
    beforeEach(async () => {
      await seedCreator(db, { slug: 'AAA', niche: 'beauty', followersCount: 50_000, engagementRate: '0.0800' });
      await seedCreator(db, { slug: 'BBB', niche: 'fashion', followersCount: 30_000, engagementRate: '0.0800' });
      await seedCreator(db, { slug: 'CCC', niche: 'general', followersCount: 20_000, engagementRate: '0.0400' });
      await seedCreator(db, { slug: 'DDD', niche: 'electronics', followersCount: 2_000_000, engagementRate: '0.0200' });
      await seedCreator(db, { slug: 'ZZZ', niche: 'beauty', followersCount: 50_000, engagementRate: '0.0900', status: 'suspended' });
    });

    it('ranks active creators by match score with an explanation', async () => {
      const { campaignId } = await setupCampaign();
      const res = await call(alice.authHeaders, 'GET', `/v1/campaigns/${campaignId}/matches`);
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.map((m: { creator: { slug: string }; score: number }) => [m.creator.slug, m.score])).toEqual([
        ['AAA', 100],
        ['BBB', 80],
        ['CCC', 60],
        ['DDD', 27],
      ]);
      expect(data[0]).toMatchObject({
        breakdown: { niche: 1, engagement: 1, reach: 1 },
        reasons: expect.arrayContaining(['Niche match: beauty']),
        already_linked: false,
      });
    });

    it('never exposes creator email or banking data to sellers', async () => {
      const { campaignId } = await setupCampaign();
      const body = (await call(alice.authHeaders, 'GET', `/v1/campaigns/${campaignId}/matches`)).body;
      expect(body).not.toContain('@creators.mx');
      expect(body).not.toContain(VALID_CLABE);
      expect(body).not.toContain('spei');
    });

    it('supports limit and niche filters', async () => {
      const { campaignId } = await setupCampaign();
      const limited = (await call(alice.authHeaders, 'GET', `/v1/campaigns/${campaignId}/matches?limit=2`)).json().data;
      expect(limited).toHaveLength(2);
      const fashion = (await call(alice.authHeaders, 'GET', `/v1/campaigns/${campaignId}/matches?niche=fashion`)).json().data;
      expect(fashion.map((m: { creator: { slug: string } }) => m.creator.slug)).toEqual(['BBB']);
    });

    it('flags creators already linked to the campaign', async () => {
      const { campaignId } = await setupCampaign();
      await issueLink(campaignId, { creator_slug: 'AAA' });
      const data = (await call(alice.authHeaders, 'GET', `/v1/campaigns/${campaignId}/matches`)).json().data;
      expect(data.find((m: { creator: { slug: string } }) => m.creator.slug === 'AAA').already_linked).toBe(true);
    });

    it('returns 404 for another seller’s campaign', async () => {
      const { campaignId } = await setupCampaign();
      expect((await call(bob.authHeaders, 'GET', `/v1/campaigns/${campaignId}/matches`)).statusCode).toBe(404);
    });
  });

  describe('POST /v1/campaigns/:id/links', () => {
    beforeEach(async () => {
      await seedCreator(db, { slug: 'LEO' });
    });

    it('issues a link with a generated script and persists the script', async () => {
      const { campaignId } = await setupCampaign();
      const res = await issueLink(campaignId, { creator_slug: 'leo' });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.link).toMatchObject({
        campaign_id: campaignId,
        creator_slug: 'LEO',
        link_slug: 'leo-glow-serum',
        url: `${LINK_BASE}/leo-glow-serum`,
        status: 'active',
        expires_at: null,
      });
      expect(body.script.cta).toContain(`${LINK_BASE}/leo-glow-serum`);
      expect(body.script.solution).toContain('Glow Serum');
      expect(body.match.score).toBeGreaterThan(0);

      const [row] = await db.select().from(links).where(eq(links.id, body.link.id));
      expect(row).toMatchObject({ influencerSlug: 'LEO', customScript: body.script.full_text });
      expect(row!.creatorId).not.toBeNull();
    });

    it('produces a link that buyers can redeem for a REF-LEO code', async () => {
      const { campaignId } = await setupCampaign();
      await issueLink(campaignId, { creator_slug: 'LEO' });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/codes/request',
        payload: { link_slug: 'leo-glow-serum', buyer: { email: 'valeria@gmail.com' } },
        remoteAddress: '10.9.9.9',
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().code).toMatch(/^REF-LEO-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    });

    it('rejects a second link for the same creator and campaign', async () => {
      const { campaignId } = await setupCampaign();
      const first = (await issueLink(campaignId, { creator_slug: 'LEO' })).json();
      const res = await issueLink(campaignId, { creator_slug: 'LEO' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'LINK_EXISTS', details: { link: { id: first.link.id } } });
    });

    it('lets only one of two concurrent requests create the link', async () => {
      const { campaignId } = await setupCampaign();
      const results = await Promise.all([issueLink(campaignId, { creator_slug: 'LEO' }), issueLink(campaignId, { creator_slug: 'LEO' })]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    });

    it('adds a random suffix when the generated slug is taken', async () => {
      const { productId, campaignId } = await setupCampaign();
      await issueLink(campaignId, { creator_slug: 'LEO' });
      const second = await call(alice.authHeaders, 'POST', '/v1/campaigns', { product_id: productId, commission_rate: 0.2 });
      const res = await issueLink(second.json().id, { creator_slug: 'LEO' });
      expect(res.statusCode).toBe(201);
      expect(res.json().link.link_slug).toMatch(/^leo-glow-serum-[23456789abcdefghjkmnpqrstvwxyz]{4}$/);
    });

    it('accepts a vanity link_slug and rejects one already in use', async () => {
      await seedCreator(db, { slug: 'ANA', email: 'ana@creators.mx' });
      const { campaignId } = await setupCampaign();
      const vanity = await issueLink(campaignId, { creator_slug: 'LEO', link_slug: 'Leo-Promo' });
      expect(vanity.json().link.link_slug).toBe('leo-promo');
      const taken = await issueLink(campaignId, { creator_slug: 'ANA', link_slug: 'leo-promo' });
      expect(taken.statusCode).toBe(409);
      expect(taken.json().error.code).toBe('LINK_SLUG_TAKEN');
    });

    it('records an optional future expiry and rejects past ones', async () => {
      const { campaignId } = await setupCampaign();
      const past = await issueLink(campaignId, { creator_slug: 'LEO', expires_at: '2026-01-01T00:00:00Z' });
      expect(past.statusCode).toBe(400);
      const ok = await issueLink(campaignId, { creator_slug: 'LEO', expires_at: '2026-12-31T00:00:00Z' });
      expect(ok.json().link.expires_at).toBe('2026-12-31T00:00:00.000Z');
    });

    it.each([
      ['unknown creator', async () => ({ body: { creator_slug: 'NOPE' } }), 404, 'CREATOR_NOT_FOUND'],
      [
        'suspended creator',
        async () => {
          await seedCreator(db, { slug: 'SUS', email: 'sus@x.mx', status: 'suspended' });
          return { body: { creator_slug: 'SUS' } };
        },
        409,
        'CREATOR_SUSPENDED',
      ],
    ])('rejects %s', async (_label, prepare, status, code) => {
      const { campaignId } = await setupCampaign();
      const { body } = await prepare();
      const res = await issueLink(campaignId, body);
      expect(res.statusCode).toBe(status);
      expect(res.json().error.code).toBe(code);
    });

    it('requires an active campaign and owner access', async () => {
      const { campaignId } = await setupCampaign();
      expect((await issueLink(campaignId, { creator_slug: 'LEO' }, bob)).statusCode).toBe(404);
      await call(alice.authHeaders, 'PATCH', `/v1/campaigns/${campaignId}`, { status: 'paused' });
      const res = await issueLink(campaignId, { creator_slug: 'LEO' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CAMPAIGN_NOT_ACTIVE');
    });

    it('lists a campaign’s links for its owner only', async () => {
      const { campaignId } = await setupCampaign();
      await issueLink(campaignId, { creator_slug: 'LEO' });
      const list = (await call(alice.authHeaders, 'GET', `/v1/campaigns/${campaignId}/links`)).json();
      expect(list.data).toHaveLength(1);
      expect((await call(bob.authHeaders, 'GET', `/v1/campaigns/${campaignId}/links`)).statusCode).toBe(404);
    });
  });

  describe('GET /v1/creators/:slug', () => {
    it('returns the profile with an empty balance for a new creator', async () => {
      await seedCreator(db, { slug: 'LEO' });
      const res = await call(ADMIN, 'GET', '/v1/creators/leo');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        creator: { slug: 'LEO', spei_clabe_masked: '**************7771' },
        balance: { available: [], pending_escrow: [] },
        links_count: 0,
      });
      expect(res.body).not.toContain(VALID_CLABE);
    });

    it('tracks a sale from pending escrow to available balance end to end', async () => {
      await seedCreator(db, { slug: 'LEO' });
      const { campaignId } = await setupCampaign();
      await issueLink(campaignId, { creator_slug: 'LEO' });
      const code = (
        await app.inject({
          method: 'POST',
          url: '/v1/codes/request',
          payload: { link_slug: 'leo-glow-serum', buyer: { email: 'valeria@gmail.com' } },
          remoteAddress: '10.9.9.9',
        })
      ).json().code;

      const raw = JSON.stringify({
        event: 'order.paid',
        seller_order_id: 'ORD-1',
        applied_discount_code: code,
        currency: 'MXN',
        financials: { gross_total: 1020, discount_total: 0, net_total: 1020 },
        timestamp: clock.now().toISOString(),
      });
      const paid = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/orders/paid',
        headers: {
          'content-type': 'application/json',
          'x-referals-seller-id': alice.seller.id,
          'x-referals-signature': signPayload(raw, alice.webhookSecret),
        },
        payload: raw,
      });
      expect(paid.json().attribution.attributed).toBe(true);

      const pending = (await call(ADMIN, 'GET', '/v1/creators/LEO')).json();
      expect(pending.balance).toEqual({
        available: [],
        pending_escrow: [{ currency: 'MXN', amount: '153.00', payout_count: 1, next_release_at: '2026-10-27T16:00:00.000Z' }],
      });
      expect(pending.links_count).toBe(1);

      clock.advance(14 * DAY);
      await new EscrowWorkerService({ db, log: { info: () => undefined, error: () => undefined }, now: clock.now }).runOnce();

      const released = (await call(ADMIN, 'GET', '/v1/creators/LEO')).json();
      expect(released.balance).toEqual({
        available: [{ currency: 'MXN', amount: '153.00', is_negative: false }],
        pending_escrow: [],
      });
    });

    it('returns 404 for unknown or malformed slugs and requires the admin token', async () => {
      expect((await call(ADMIN, 'GET', '/v1/creators/NOPE')).statusCode).toBe(404);
      expect((await call(ADMIN, 'GET', '/v1/creators/a!')).statusCode).toBe(404);
      await seedCreator(db, { slug: 'LEO' });
      expect((await call(alice.authHeaders, 'GET', '/v1/creators/LEO')).statusCode).toBe(401);
    });
  });

  describe('creator self-service (/v1/creators/me*)', () => {
    type SeededCreator = Awaited<ReturnType<typeof seedCreator>>;
    let leo: SeededCreator;

    const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

    /** Drives a full attributed sale for LEO through the public APIs. */
    const sellThroughLeo = async (orderId = 'ORD-1') => {
      const code = (
        await app.inject({
          method: 'POST',
          url: '/v1/codes/request',
          payload: { link_slug: 'leo-glow-serum', buyer: { email: `${orderId}@gmail.com` } },
          remoteAddress: '10.9.9.9',
        })
      ).json().code;
      const raw = JSON.stringify({
        event: 'order.paid',
        seller_order_id: orderId,
        applied_discount_code: code,
        currency: 'MXN',
        financials: { gross_total: 1020, discount_total: 0, net_total: 1020 },
        timestamp: clock.now().toISOString(),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/orders/paid',
        headers: {
          'content-type': 'application/json',
          'x-referals-seller-id': alice.seller.id,
          'x-referals-signature': signPayload(raw, alice.webhookSecret),
        },
        payload: raw,
      });
      expect(res.json().attribution.attributed).toBe(true);
    };

    beforeEach(async () => {
      leo = await seedCreator(db, { slug: 'LEO' });
    });

    describe('onboarding & authentication', () => {
      it('issues a working cr_live_ key at onboarding and stores only its hash', async () => {
        const res = await call(ADMIN, 'POST', '/v1/creators', registerBody({ slug: 'SOFIA', email: 'sofia@creators.mx' }));
        expect(res.statusCode).toBe(201);
        const { api_key: apiKey, slug } = res.json();
        expect(apiKey).toMatch(/^cr_live_[A-Za-z0-9_-]{32}$/);

        const [row] = await db.select().from(creators).where(eq(creators.slug, slug));
        expect(row!.apiKeyHash).toBe(hashApiKey(apiKey));
        expect(JSON.stringify(row)).not.toContain(apiKey);

        const me = await call(bearer(apiKey), 'GET', '/v1/creators/me');
        expect(me.statusCode).toBe(200);
        expect(me.json().creator.slug).toBe('SOFIA');
      });

      it('accepts the X-Referals-Creator-Key header', async () => {
        const res = await call({ 'x-referals-creator-key': leo.apiKey }, 'GET', '/v1/creators/me');
        expect(res.json().creator.slug).toBe('LEO');
      });

      it.each([
        ['no credentials', {}],
        ['malformed key', { authorization: 'Bearer cr_live_short' }],
        ['unknown well-formed key', { authorization: `Bearer cr_live_${'A'.repeat(32)}` }],
        ['admin token', { 'x-referals-admin-token': ADMIN_TOKEN }],
      ])('rejects %s with 401', async (_label, headers) => {
        const res = await call(headers, 'GET', '/v1/creators/me');
        expect(res.statusCode).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer realm="referals-creators"');
      });

      it('does not accept seller keys, and creator keys do not open seller endpoints', async () => {
        expect((await call(alice.authHeaders, 'GET', '/v1/creators/me')).statusCode).toBe(401);
        expect((await call(leo.authHeaders, 'GET', '/v1/products')).statusCode).toBe(401);
      });

      it('rejects suspended creators with 403', async () => {
        await db.update(creators).set({ status: 'suspended' }).where(eq(creators.id, leo.id));
        const res = await call(leo.authHeaders, 'GET', '/v1/creators/me');
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('CREATOR_SUSPENDED');
      });

      it('rotation revokes the old key immediately', async () => {
        const rotated = await call(leo.authHeaders, 'POST', '/v1/creators/me/rotate-api-key');
        expect(rotated.statusCode).toBe(200);
        const { api_key: newKey } = rotated.json();
        expect(newKey).toMatch(/^cr_live_[A-Za-z0-9_-]{32}$/);
        expect(newKey).not.toBe(leo.apiKey);

        expect((await call(leo.authHeaders, 'GET', '/v1/creators/me')).statusCode).toBe(401);
        expect((await call(bearer(newKey), 'GET', '/v1/creators/me')).json().creator.slug).toBe('LEO');
      });
    });

    describe('GET /v1/creators/me', () => {
      it('returns the profile with masked CLABE and a zero MXN balance before any activity', async () => {
        const res = await call(leo.authHeaders, 'GET', '/v1/creators/me');
        expect(res.headers['cache-control']).toBe('no-store');
        const zero = { currency: 'MXN', available_cents: 0, pending_escrow_cents: 0, is_negative: false, next_release_at: null };
        expect(res.json()).toEqual({
          creator: expect.objectContaining({ slug: 'LEO', spei_clabe_masked: '**************7771', payout_ready: true }),
          balance: zero,
          balances: [zero],
        });
        expect(res.body).not.toContain(VALID_CLABE);
        expect(res.body).not.toContain('api_key');
      });

      it('moves a sale from pending escrow to available, and reports negative balances', async () => {
        const { campaignId } = await setupCampaign();
        await issueLink(campaignId, { creator_slug: 'LEO' });
        await sellThroughLeo();

        const pending = (await call(leo.authHeaders, 'GET', '/v1/creators/me')).json().balance;
        expect(pending).toEqual({
          currency: 'MXN',
          available_cents: 0,
          pending_escrow_cents: 15_300,
          is_negative: false,
          next_release_at: '2026-10-27T16:00:00.000Z',
        });

        clock.advance(14 * DAY);
        await new EscrowWorkerService({ db, log: { info: () => undefined, error: () => undefined }, now: clock.now }).runOnce();
        const released = (await call(leo.authHeaders, 'GET', '/v1/creators/me')).json().balance;
        expect(released).toMatchObject({ available_cents: 15_300, pending_escrow_cents: 0, is_negative: false });

        await db.insert(ledgerEntries).values({
          influencerSlug: 'LEO',
          entryType: 'withdrawal_adjustment',
          amount: '-200.00',
          description: 'SPEI withdrawal',
        });
        const negative = (await call(leo.authHeaders, 'GET', '/v1/creators/me')).json().balance;
        expect(negative).toMatchObject({ available_cents: -4_700, is_negative: true });
      });
    });

    describe('PATCH /v1/creators/me', () => {
      const NEW_CLABE = '032180000118359719';

      it('updates and re-validates the CLABE', async () => {
        const res = await call(leo.authHeaders, 'PATCH', '/v1/creators/me', { spei_clabe: '032 180 00011835971 9' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ slug: 'LEO', spei_clabe_masked: '**************9719', payout_ready: true });
        expect(res.body).not.toContain(NEW_CLABE);
        const [row] = await db.select().from(creators).where(eq(creators.id, leo.id));
        expect(row!.speiClabe).toBe(NEW_CLABE);
      });

      it('rejects a CLABE with a bad check digit and leaves the stored one untouched', async () => {
        const res = await call(leo.authHeaders, 'PATCH', '/v1/creators/me', { spei_clabe: '032180000118359718' });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.details.issues[0].path).toBe('spei_clabe');
        const [row] = await db.select().from(creators).where(eq(creators.id, leo.id));
        expect(row!.speiClabe).toBe(VALID_CLABE);
      });

      it('updates name and normalizes the handle', async () => {
        const res = await call(leo.authHeaders, 'PATCH', '/v1/creators/me', { name: 'Leo Méndez', handle: 'LeoGlowMX' });
        expect(res.json()).toMatchObject({ name: 'Leo Méndez', handle: '@leoglowmx', slug: 'LEO' });
      });

      it.each([
        ['the slug (immutable)', { slug: 'NEWLEO' }],
        ['the email', { email: 'x@y.mx' }],
        ['the status', { status: 'active' }],
        ['an empty body', {}],
      ])('rejects changing %s', async (_label, body) => {
        expect((await call(leo.authHeaders, 'PATCH', '/v1/creators/me', body)).statusCode).toBe(400);
      });
    });

    describe('GET /v1/creators/me/links', () => {
      it("lists only the creator's own links with product, URLs and the generated script", async () => {
        await seedCreator(db, { slug: 'ANA', email: 'ana@creators.mx' });
        const { campaignId } = await setupCampaign();
        const issued = (await issueLink(campaignId, { creator_slug: 'LEO' })).json();
        await issueLink(campaignId, { creator_slug: 'ANA' });

        const res = await call(leo.authHeaders, 'GET', '/v1/creators/me/links');
        expect(res.statusCode).toBe(200);
        expect(res.json().data).toEqual([
          {
            id: issued.link.id,
            campaign_id: campaignId,
            campaign_status: 'active',
            link_slug: 'leo-glow-serum',
            referral_url: `${LINK_BASE}/leo-glow-serum`,
            product_name: 'Glow Serum',
            checkout_url: 'https://shop.example.mx/checkout',
            custom_script: issued.script.full_text,
            status: 'active',
            expires_at: null,
            created_at: issued.link.created_at,
          },
        ]);
      });

      it('returns an empty list for a creator without links', async () => {
        expect((await call(leo.authHeaders, 'GET', '/v1/creators/me/links')).json()).toEqual({ data: [] });
      });
    });

    it('keeps the admin profile route working alongside /me', async () => {
      const res = await call(ADMIN, 'GET', '/v1/creators/LEO');
      expect(res.statusCode).toBe(200);
      expect(res.json().creator.slug).toBe('LEO');
    });
  });
});
