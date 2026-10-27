import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { campaignInvitations } from '../../src/db/schema.js';
import { INVITATION_QUOTA_CONFIG } from '../../src/modules/matchmaker/invitations.service.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedAuthenticatedSeller, seedCreator } from '../helpers.js';

type Seller = Awaited<ReturnType<typeof seedAuthenticatedSeller>>;
type Creator = Awaited<ReturnType<typeof seedCreator>>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const { MAX_PENDING_PER_CAMPAIGN, MAX_DAILY_PER_SELLER } = INVITATION_QUOTA_CONFIG;

describe('invitation quotas & anti-spam limits', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let alice: Seller;
  let bob: Seller;
  let pool: Creator[];

  const asSeller = (seller: Seller, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: seller.authHeaders, ...(payload ? { payload } : {}) });

  const newCampaign = async (seller = alice, name = 'Glow Serum') => {
    const product = await asSeller(seller, 'POST', '/v1/products', {
      name,
      price: 649,
      margin: 200,
      checkout_base_url: 'https://shop.example.mx/checkout',
      category: 'beauty',
    });
    return (await asSeller(seller, 'POST', '/v1/campaigns', { product_id: product.json().id, commission_rate: 0.15 })).json()
      .id as string;
  };

  const invite = (campaignId: string, creator: Creator, seller = alice) =>
    asSeller(seller, 'POST', `/v1/campaigns/${campaignId}/invitations`, { creator_slug: creator.slug });

  /** Sends invitations one by one, asserting each succeeds. */
  const inviteAll = async (campaignId: string, creators: Creator[], seller = alice) => {
    for (const c of creators) {
      const res = await invite(campaignId, c, seller);
      expect(res.statusCode, res.body).toBe(201);
    }
  };

  const respond = async (creator: Creator, action: 'accept' | 'decline') => {
    const inbox = (await app.inject({ method: 'GET', url: '/v1/creators/me/invitations', headers: creator.authHeaders })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/creators/me/invitations/${inbox.data[0].id}/${action}`,
      headers: creator.authHeaders,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
  };

  const quotaOf = async (campaignId: string, seller = alice) =>
    (await asSeller(seller, 'GET', `/v1/campaigns/${campaignId}/matches`)).json().quota;

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-26T18:00:00.000Z'));
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, now: clock.now, generatorOptions: { now: clock.now } },
      { logger: false },
    );
    alice = await seedAuthenticatedSeller(db, 'Alice Beauty');
    bob = await seedAuthenticatedSeller(db, 'Bob Gadgets');
    pool = [];
    for (let i = 0; i < 60; i++) pool.push(await seedCreator(db, { slug: `K${String(i).padStart(2, '0')}` }));
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  describe('active pending limit (25 per campaign)', () => {
    it('rejects the 26th pending invitation with 422 and the quota state', async () => {
      const campaignId = await newCampaign();
      await inviteAll(campaignId, pool.slice(0, MAX_PENDING_PER_CAMPAIGN));

      const res = await invite(campaignId, pool[25]!);
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatchObject({
        code: 'INVITATION_PENDING_LIMIT_REACHED',
        details: {
          current_pending: 25,
          max_pending: 25,
          quota: { active_pending: 25, max_pending: 25, sent_last_24h: 25, daily_limit: 50, can_invite: false },
        },
      });
      expect(await db.select().from(campaignInvitations)).toHaveLength(25);
    });

    it('is per campaign: a full campaign does not block the seller’s other campaigns', async () => {
      const full = await newCampaign();
      const other = await newCampaign(alice, 'Night Cream');
      await inviteAll(full, pool.slice(0, 25));
      expect((await invite(other, pool[25]!)).statusCode).toBe(201);
    });

    it('frees a slot when a creator accepts', async () => {
      const campaignId = await newCampaign();
      await inviteAll(campaignId, pool.slice(0, 25));
      await respond(pool[0]!, 'accept');
      expect((await quotaOf(campaignId)).active_pending).toBe(24);
      expect((await invite(campaignId, pool[25]!)).statusCode).toBe(201);
      expect((await invite(campaignId, pool[26]!)).statusCode).toBe(422);
    });

    it('frees a slot when a creator declines', async () => {
      const campaignId = await newCampaign();
      await inviteAll(campaignId, pool.slice(0, 25));
      await respond(pool[3]!, 'decline');
      expect((await invite(campaignId, pool[25]!)).statusCode).toBe(201);
    });

    it('frees slots as invitations expire (no sweeper needed)', async () => {
      const campaignId = await newCampaign();
      await inviteAll(campaignId, pool.slice(0, 25));
      clock.advance(7 * DAY); // expires_at <= now → expired
      expect(await quotaOf(campaignId)).toMatchObject({ active_pending: 0, sent_last_24h: 0, can_invite: true });
      expect((await invite(campaignId, pool[25]!)).statusCode).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------
  describe('daily rolling quota (50 per seller per 24h)', () => {
    it('rejects the 51st send across campaigns with 429, Retry-After and the quota state', async () => {
      const [c1, c2, c3] = [await newCampaign(), await newCampaign(alice, 'Night Cream'), await newCampaign(alice, 'Toner')];
      await inviteAll(c1!, pool.slice(0, 10)); // oldest sends at 18:00
      clock.advance(HOUR);
      await inviteAll(c2!, pool.slice(10, 30));
      await inviteAll(c3!, pool.slice(30, 50));

      const res = await invite(c1!, pool[50]!);
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe(String(23 * 60 * 60));
      expect(res.json().error).toMatchObject({
        code: 'DAILY_INVITATION_QUOTA_EXCEEDED',
        details: {
          sent_last_24h: 50,
          daily_limit: 50,
          retry_after_seconds: 23 * 60 * 60,
          quota: { active_pending: 10, sent_last_24h: 50, can_invite: false },
        },
      });
      expect(await db.select().from(campaignInvitations)).toHaveLength(50);
    });

    it('slides: sends free up exactly when the oldest ones turn 24h old', async () => {
      const [c1, c2] = [await newCampaign(), await newCampaign(alice, 'Night Cream')];
      await inviteAll(c1!, pool.slice(0, 10));
      clock.advance(6 * HOUR);
      await inviteAll(c2!, pool.slice(10, 25));
      await inviteAll(await newCampaign(alice, 'Toner'), pool.slice(25, 50));

      const blocked = await invite(c1!, pool[50]!);
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBe(18 * 60 * 60);
      clock.advance(retryAfter * 1000 - 1000);
      expect((await invite(c1!, pool[50]!)).statusCode).toBe(429);
      clock.advance(1000);

      // The 10 sends from 24h ago left the window; the 40 from 6h later still count.
      expect((await quotaOf(c1!)).sent_last_24h).toBe(40);
      await inviteAll(c1!, pool.slice(50, 60));
      expect((await invite(c2!, pool[0]!)).statusCode).toBe(429);
    });

    it('is per seller: one seller’s exhausted quota does not affect another', async () => {
      const [c1, c2] = [await newCampaign(), await newCampaign(alice, 'Night Cream')];
      await inviteAll(c1!, pool.slice(0, 25));
      await inviteAll(c2!, pool.slice(25, 50));
      expect((await invite(await newCampaign(alice, 'Toner'), pool[50]!)).statusCode).toBe(429);
      const bobs = await newCampaign(bob, 'Earbuds');
      expect((await invite(bobs, pool[50]!, bob)).statusCode).toBe(201);
    });

    it('counts a re-sent expired invitation as a new send', async () => {
      const campaignId = await newCampaign();
      await inviteAll(campaignId, pool.slice(0, 1));
      clock.advance(8 * DAY);
      expect((await quotaOf(campaignId)).sent_last_24h).toBe(0);
      await inviteAll(campaignId, pool.slice(0, 1));
      expect(await quotaOf(campaignId)).toMatchObject({ active_pending: 1, sent_last_24h: 1 });
    });

    it('checks the campaign pending limit before the daily quota', async () => {
      const [c1, c2] = [await newCampaign(), await newCampaign(alice, 'Night Cream')];
      await inviteAll(c1!, pool.slice(0, 25));
      await inviteAll(c2!, pool.slice(25, 50));
      expect((await invite(c1!, pool[50]!)).json().error.code).toBe('INVITATION_PENDING_LIMIT_REACHED');
    });

    it('rejected attempts do not consume quota', async () => {
      const campaignId = await newCampaign();
      await inviteAll(campaignId, pool.slice(0, 25));
      for (let i = 0; i < 5; i++) expect((await invite(campaignId, pool[25 + i]!)).statusCode).toBe(422);
      expect((await quotaOf(campaignId)).sent_last_24h).toBe(25);
    });
  });

  // ---------------------------------------------------------------------------
  describe('quota visibility', () => {
    it('exposes quota in GET /matches and in the invite response', async () => {
      const campaignId = await newCampaign();
      expect(await quotaOf(campaignId)).toEqual({
        active_pending: 0,
        max_pending: 25,
        sent_last_24h: 0,
        daily_limit: 50,
        can_invite: true,
        retry_after_seconds: null,
      });
      const res = await invite(campaignId, pool[0]!);
      expect(res.json().quota).toMatchObject({ active_pending: 1, sent_last_24h: 1, can_invite: true });
      expect(await quotaOf(campaignId)).toMatchObject({ active_pending: 1, sent_last_24h: 1 });
    });

    it('stays tenant-scoped (404 for another seller’s campaign)', async () => {
      const campaignId = await newCampaign();
      expect((await asSeller(bob, 'GET', `/v1/campaigns/${campaignId}/matches`)).statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  describe('concurrency', () => {
    it('a concurrent burst never exceeds the pending limit', async () => {
      const campaignId = await newCampaign();
      const results = await Promise.all(pool.slice(0, 35).map((c) => invite(campaignId, c)));
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 201)).toHaveLength(25);
      expect(codes.filter((c) => c === 422)).toHaveLength(10);
      expect(await db.select().from(campaignInvitations)).toHaveLength(25);
    });

    it('a concurrent burst across campaigns never exceeds the daily quota', async () => {
      const campaigns = [await newCampaign(), await newCampaign(alice, 'Night Cream'), await newCampaign(alice, 'Toner')];
      const results = await Promise.all(pool.map((c, i) => invite(campaigns[i % 3]!, c)));
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 201)).toHaveLength(MAX_DAILY_PER_SELLER);
      expect(codes.filter((c) => c === 429)).toHaveLength(10);
      expect(await db.select().from(campaignInvitations)).toHaveLength(50);
    });
  });
});
