import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { campaignInvitations, creators } from '../../src/db/schema.js';
import { InMemoryWhatsAppOutbox, WhatsAppSendError } from '../../src/modules/notifications/whatsapp.service.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedAuthenticatedSeller, seedCreator } from '../helpers.js';

type Seller = Awaited<ReturnType<typeof seedAuthenticatedSeller>>;
type Creator = Awaited<ReturnType<typeof seedCreator>>;

const PHONE = '+525512345678';
const DAY = 24 * 60 * 60 * 1000;

describe('campaign invitations → WhatsApp', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let outbox: InMemoryWhatsAppOutbox;
  let alice: Seller;
  let leo: Creator;
  let campaignId: string;

  const build = async (extra: { creatorAppUrl?: string } = {}) => {
    app = buildApp(
      {
        db,
        redis: await createTestRedis(),
        webhookEncryptionKey: TEST_ENCRYPTION_KEY,
        whatsappProvider: outbox,
        now: clock.now,
        ...extra,
      },
      { logger: false },
    );
  };

  const patchMe = (creator: Creator, payload: object) =>
    app.inject({ method: 'PATCH', url: '/v1/creators/me', headers: creator.authHeaders, payload });

  const invite = (slug = 'LEO') =>
    app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaignId}/invitations`,
      headers: alice.authHeaders,
      payload: { creator_slug: slug },
    });

  /** Background sends happen after the response; give the event loop a moment when asserting "nothing sent". */
  const settle = () => new Promise((r) => setTimeout(r, 25));

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-26T18:00:00.000Z'));
    outbox = new InMemoryWhatsAppOutbox();
    await build();
    alice = await seedAuthenticatedSeller(db, 'Alice Beauty');
    leo = await seedCreator(db, { slug: 'LEO', name: 'Leo Mendez', handle: '@soyleomx' });
    const product = await app.inject({
      method: 'POST',
      url: '/v1/products',
      headers: alice.authHeaders,
      payload: { name: 'Glow Serum', price: 649, margin: 200, checkout_base_url: 'https://shop.example.mx/checkout', category: 'beauty' },
    });
    campaignId = (
      await app.inject({
        method: 'POST',
        url: '/v1/campaigns',
        headers: alice.authHeaders,
        payload: { product_id: product.json().id, commission_rate: 0.15 },
      })
    ).json().id;
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  describe('PATCH /v1/creators/me — phone & WhatsApp opt-in', () => {
    it('normalizes the number to E.164 and records consent', async () => {
      const res = await patchMe(leo, { phone: '+52 55 1234-5678', whatsapp_opt_in: true });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ phone: PHONE, whatsapp_opt_in: true });
      const [row] = await db.select().from(creators).where(eq(creators.id, leo.id));
      expect(row).toMatchObject({ phone: PHONE, whatsappOptInAt: clock.now() });
    });

    it.each([
      ['no country code', '55 1234 5678'],
      ['a leading zero country code', '+0525512345678'],
      ['letters', '+52 55 CALL ME'],
      ['too long', '+5255123456789012'],
    ])('rejects a phone with %s (400)', async (_label, phone) => {
      const res = await patchMe(leo, { phone });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.issues[0].path).toBe('phone');
    });

    it('requires a phone before opting in', async () => {
      const res = await patchMe(leo, { whatsapp_opt_in: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.issues[0].path).toBe('whatsapp_opt_in');
    });

    it('withdraws consent when the number changes or is removed, unless re-confirmed', async () => {
      await patchMe(leo, { phone: PHONE, whatsapp_opt_in: true });
      expect((await patchMe(leo, { phone: '+525598765432' })).json()).toMatchObject({ phone: '+525598765432', whatsapp_opt_in: false });
      expect((await patchMe(leo, { phone: '+525598765432', whatsapp_opt_in: true })).json().whatsapp_opt_in).toBe(true);
      expect((await patchMe(leo, { name: 'Leo M.' })).json().whatsapp_opt_in).toBe(true); // unrelated edits keep it
      expect((await patchMe(leo, { phone: null })).json()).toMatchObject({ phone: null, whatsapp_opt_in: false });
    });

    it('lets creators opt out while keeping the number', async () => {
      await patchMe(leo, { phone: PHONE, whatsapp_opt_in: true });
      expect((await patchMe(leo, { whatsapp_opt_in: false })).json()).toMatchObject({ phone: PHONE, whatsapp_opt_in: false });
    });

    it('never exposes the phone number on public or seller-facing responses', async () => {
      await patchMe(leo, { phone: PHONE, whatsapp_opt_in: true });
      const matches = await app.inject({ method: 'GET', url: `/v1/campaigns/${campaignId}/matches`, headers: alice.authHeaders });
      const invited = await invite();
      const storefront = await app.inject({ method: 'GET', url: '/v1/storefronts/leo' });
      for (const res of [matches, invited, storefront]) {
        expect(res.body).not.toContain('5512345678');
        expect(res.body).not.toContain('phone');
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /v1/campaigns/:id/invitations — WhatsApp dispatch', () => {
    it('sends the opted-in creator a personalized notice with earnings and a review link', async () => {
      await patchMe(leo, { phone: PHONE, whatsapp_opt_in: true });
      const res = await invite();
      expect(res.statusCode).toBe(201);
      const invitationId = res.json().id;

      await vi.waitFor(() => expect(outbox.messages).toHaveLength(1));
      const [msg] = outbox.messages;
      expect(msg).toMatchObject({
        to: PHONE,
        template: 'campaign_invitation',
        language: 'es_MX',
        parameters: [
          'Leo',
          'Alice Beauty',
          'Glow Serum',
          '$97.35 MXN', // 15% of 649.00
          expect.stringMatching(new RegExp(`^https://referals\\.mx/c/invitations/${invitationId}\\?token=[A-Za-z0-9_-]{43}$`)),
          '2 de noviembre',
        ],
      });
      expect(msg!.previewText).toContain('Alice Beauty te invitó a promocionar Glow Serum');
    });

    it('answers before WhatsApp is contacted (the send runs in the background)', async () => {
      await patchMe(leo, { phone: PHONE, whatsapp_opt_in: true });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const send = vi.spyOn(outbox, 'send').mockImplementation(async (m) => {
        await gate; // WhatsApp "hangs"
        outbox.messages.push({ ...m, id: 'late' });
        return { id: 'late' };
      });

      const res = await invite();
      expect(res.statusCode).toBe(201); // returned while WhatsApp is still pending
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(outbox.messages).toHaveLength(0);
      release();
      await vi.waitFor(() => expect(outbox.messages).toHaveLength(1));
    });

    it.each([
      ['has no phone', {}],
      ['has a phone but did not opt in', { phone: PHONE }],
      ['opted out', { phone: PHONE, whatsapp_opt_in: false }],
    ])('still invites (201) but sends nothing when the creator %s', async (_label, profile) => {
      if (Object.keys(profile).length) await patchMe(leo, profile);
      const res = await invite();
      expect(res.statusCode).toBe(201);
      await settle();
      expect(outbox.messages).toHaveLength(0);
      expect(await db.select().from(campaignInvitations)).toHaveLength(1);
    });

    it('never fails the invitation when WhatsApp is down', async () => {
      await patchMe(leo, { phone: PHONE, whatsapp_opt_in: true });
      outbox.failWith = new WhatsAppSendError('WhatsApp responded 503: Service unavailable', 503);
      const res = await invite();
      expect(res.statusCode).toBe(201);
      await settle();
      const [row] = await db.select().from(campaignInvitations);
      expect(row!.status).toBe('pending');
    });

    it('notifies again when an expired invitation is re-sent, but not on a rejected duplicate', async () => {
      await patchMe(leo, { phone: PHONE, whatsapp_opt_in: true });
      await invite();
      await vi.waitFor(() => expect(outbox.messages).toHaveLength(1));

      expect((await invite()).statusCode).toBe(409); // still pending
      await settle();
      expect(outbox.messages).toHaveLength(1);

      clock.advance(8 * DAY);
      expect((await invite()).statusCode).toBe(201); // re-sent
      await vi.waitFor(() => expect(outbox.messages).toHaveLength(2));
      expect(outbox.messages[1]!.parameters[5]).toBe('10 de noviembre');
    });

    it('builds review links on the configured creator app', async () => {
      await app.close();
      await build({ creatorAppUrl: 'https://app.referrals.mx/' });
      await patchMe(leo, { phone: PHONE, whatsapp_opt_in: true });
      const invitationId = (await invite()).json().id;
      await vi.waitFor(() => expect(outbox.messages).toHaveLength(1));
      expect(outbox.messages[0]!.parameters[4]!.startsWith(`https://app.referrals.mx/c/invitations/${invitationId}?token=`)).toBe(true);
    });
  });
});
