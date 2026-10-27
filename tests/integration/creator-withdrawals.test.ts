import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { creators, ledgerEntries, links, withdrawalRequests } from '../../src/db/schema.js';
import { clabeCheckDigit } from '../../src/lib/clabe.js';
import { EscrowWorkerService } from '../../src/modules/escrow/escrow-worker.service.js';
import { signPayload } from '../../src/modules/webhooks/signature.js';
import {
  TEST_ENCRYPTION_KEY,
  TEST_WEBHOOK_SECRET,
  TestClock,
  createTestDb,
  createTestRedis,
  seedCreator,
  seedLink,
  seedSeller,
} from '../helpers.js';

type Creator = Awaited<ReturnType<typeof seedCreator>>;

const BANAMEX = '002010077777777771';
const stpClabe = () => {
  const first17 = '64618000011835971';
  return `${first17}${clabeCheckDigit(first17)}`;
};
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('creator balances & SPEI withdrawals', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let leo: Creator;

  const call = (creator: Creator, method: 'GET' | 'PUT' | 'POST' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...creator.authHeaders, ...headers }, ...(payload ? { payload } : {}) });

  const setProfile = (creator: Creator, body: Record<string, unknown> = {}) =>
    call(creator, 'PUT', '/v1/creators/me/payout-profile', { clabe: BANAMEX, legal_name: 'Leonardo Méndez Ruiz', ...body });

  /** Credits matured commission straight into the ledger (what the escrow worker does). */
  const credit = (creator: Creator, amount: string) =>
    db.insert(ledgerEntries).values({ influencerSlug: creator.slug, entryType: 'escrow_release', amount, description: 'test credit' });

  const balance = async (creator: Creator) => (await call(creator, 'GET', '/v1/creators/me/balance')).json();
  const withdraw = (creator: Creator, body: object = {}, headers: Record<string, string> = {}) =>
    call(creator, 'POST', '/v1/creators/me/withdrawals', body, headers);

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-26T18:00:00.000Z'));
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, now: clock.now, generatorOptions: { now: clock.now } },
      { logger: false },
    );
    // No CLABE on file: tests register it through the payout profile.
    leo = await seedCreator(db, { slug: 'LEO', name: 'Leo Mendez', speiClabe: null });
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  describe('payout profile (GET/PUT /v1/creators/me/payout-profile)', () => {
    it('registers CLABE, legal name and RFC; resolves the bank; never returns the full CLABE', async () => {
      const res = await setProfile(leo, { rfc: 'mera850101ab1', clabe: '002 010 07777777777 1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        clabe_masked: '**************7771',
        bank_code: '002',
        bank_name: 'Banamex',
        legal_name: 'Leonardo Méndez Ruiz',
        rfc: 'MERA850101AB1',
        payout_ready: true,
        withdrawals_available_at: null, // first registration: no cooling-off
      });
      expect(res.body).not.toContain(BANAMEX);
      expect((await call(leo, 'GET', '/v1/creators/me/payout-profile')).json()).toEqual(res.json());
      const [row] = await db.select().from(creators).where(eq(creators.id, leo.id));
      expect(row).toMatchObject({ speiClabe: BANAMEX, payoutLegalName: 'Leonardo Méndez Ruiz', rfc: 'MERA850101AB1' });
    });

    it.each([
      ['a bad CLABE checksum', { clabe: '002010077777777772' }, 'clabe', 'Invalid CLABE checksum'],
      ['a 17-digit CLABE', { clabe: '00201007777777777' }, 'clabe', 'CLABE must be exactly 18 digits'],
      ['a malformed RFC', { rfc: 'ABC123' }, 'rfc', 'rfc must be a valid Mexican RFC (12 or 13 characters)'],
      ['an RFC with an impossible date', { rfc: 'MERA851301AB1' }, 'rfc', 'rfc must be a valid Mexican RFC (12 or 13 characters)'],
      ['a missing legal name', { legal_name: '' }, 'legal_name', expect.any(String)],
    ])('rejects %s (400)', async (_label, body, path, message) => {
      const res = await setProfile(leo, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.issues).toContainEqual({ path, message });
    });

    it('accepts a company RFC (12 characters) and clears RFC with null', async () => {
      expect((await setProfile(leo, { rfc: 'ABC850101AB1' })).json().rfc).toBe('ABC850101AB1');
      expect((await setProfile(leo, { rfc: null })).json().rfc).toBeNull();
    });

    it('starts a 24h cooling-off when an existing CLABE is replaced (not when re-saved unchanged)', async () => {
      await setProfile(leo);
      expect((await setProfile(leo, { legal_name: 'Leonardo Méndez' })).json().withdrawals_available_at).toBeNull();
      const changed = await setProfile(leo, { clabe: stpClabe() });
      expect(changed.json()).toMatchObject({ bank_name: 'STP', withdrawals_available_at: '2026-10-27T18:00:00.000Z' });
    });

    it('also starts the cooling-off when the CLABE is changed via PATCH /v1/creators/me', async () => {
      await setProfile(leo);
      await call(leo, 'PATCH', '/v1/creators/me', { spei_clabe: stpClabe() });
      expect((await call(leo, 'GET', '/v1/creators/me/payout-profile')).json().withdrawals_available_at).toBe('2026-10-27T18:00:00.000Z');
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /v1/creators/me/balance', () => {
    it('is all zeros for a new creator', async () => {
      expect(await balance(leo)).toEqual({
        currency: 'MXN',
        available_balance_cents: 0,
        pending_escrow_balance_cents: 0,
        lifetime_earnings_cents: 0,
        withdrawals_in_progress_cents: 0,
        is_negative: false,
      });
    });

    it('tracks a real sale: escrow → available, and a post-escrow refund claws it back', async () => {
      const seller = await seedSeller(db);
      const { link } = await seedLink(db, { sellerId: seller.id, influencerSlug: 'LEO', linkSlug: 'leo-glow' });
      await db.update(links).set({ creatorId: leo.id }).where(eq(links.id, link.id));
      const code = (
        await app.inject({ method: 'POST', url: '/v1/codes/request', payload: { link_slug: 'leo-glow', buyer: { email: 'v@gmail.com' } }, remoteAddress: '10.80.0.1' })
      ).json().code;
      const webhook = (path: string, body: object) => {
        const raw = JSON.stringify(body);
        return app.inject({
          method: 'POST',
          url: `/v1/webhooks/orders/${path}`,
          headers: { 'content-type': 'application/json', 'x-referals-seller-id': seller.id, 'x-referals-signature': signPayload(raw, TEST_WEBHOOK_SECRET) },
          payload: raw,
        });
      };
      await webhook('paid', {
        event: 'order.paid',
        seller_order_id: 'ORD-1',
        applied_discount_code: code,
        currency: 'MXN',
        financials: { gross_total: 1020, discount_total: 0, net_total: 1020 },
        timestamp: clock.now().toISOString(),
      });
      expect(await balance(leo)).toMatchObject({ available_balance_cents: 0, pending_escrow_balance_cents: 15_300, lifetime_earnings_cents: 15_300 });

      clock.advance(14 * DAY);
      await new EscrowWorkerService({ db, log: { info: () => undefined, error: () => undefined }, now: clock.now }).runOnce();
      expect(await balance(leo)).toMatchObject({ available_balance_cents: 15_300, pending_escrow_balance_cents: 0, lifetime_earnings_cents: 15_300 });

      await webhook('refunded', { event: 'order.refunded', seller_order_id: 'ORD-1', timestamp: clock.now().toISOString() });
      expect(await balance(leo)).toMatchObject({ available_balance_cents: 0, pending_escrow_balance_cents: 0, lifetime_earnings_cents: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /v1/creators/me/withdrawals', () => {
    beforeEach(async () => {
      await setProfile(leo, { rfc: 'MERA850101AB1' });
      await credit(leo, '500.00');
    });

    it('atomically debits the ledger and records a pending SPEI withdrawal to the snapshotted account', async () => {
      const res = await withdraw(leo, { amount_cents: 20_000 });
      expect(res.statusCode).toBe(201);
      const w = res.json();
      expect(w).toEqual({
        id: expect.any(String),
        amount_cents: 20_000,
        amount: '200.00',
        currency: 'MXN',
        status: 'pending',
        destination: { clabe_masked: '**************7771', bank_code: '002', bank_name: 'Banamex', beneficiary_name: 'Leonardo Méndez Ruiz' },
        tracking_key: null,
        failure_reason: null,
        requested_at: '2026-10-26T18:00:00.000Z',
        processed_at: null,
      });
      expect(res.body).not.toContain(BANAMEX);

      expect(await balance(leo)).toMatchObject({ available_balance_cents: 30_000, withdrawals_in_progress_cents: 20_000 });
      const [row] = await db.select().from(withdrawalRequests);
      expect(row).toMatchObject({ creatorId: leo.id, clabe: BANAMEX, bankCode: '002', beneficiaryName: 'Leonardo Méndez Ruiz', rfc: 'MERA850101AB1', status: 'pending' });
      const [debit] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.id, row!.ledgerEntryId));
      expect(debit).toMatchObject({ influencerSlug: 'LEO', entryType: 'withdrawal_adjustment', amount: '-200.00', currency: 'MXN' });
    });

    it('withdraws the full available balance when no amount is given', async () => {
      const res = await withdraw(leo);
      expect(res.json()).toMatchObject({ amount_cents: 50_000 });
      expect((await balance(leo)).available_balance_cents).toBe(0);
    });

    it('refuses more than the available balance (409) and writes nothing', async () => {
      const res = await withdraw(leo, { amount_cents: 50_001 });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'INSUFFICIENT_FUNDS', details: { available_balance_cents: 50_000, requested_cents: 50_001 } });
      expect(await db.select().from(withdrawalRequests)).toHaveLength(0);
      expect((await balance(leo)).available_balance_cents).toBe(50_000);
    });

    it('enforces the $100.00 MXN minimum (422)', async () => {
      const res = await withdraw(leo, { amount_cents: 9_999 });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatchObject({ code: 'BELOW_MINIMUM_WITHDRAWAL', details: { minimum_cents: 10_000 } });
    });

    it('refuses when the balance is negative after a clawback', async () => {
      await db.insert(ledgerEntries).values({ influencerSlug: 'LEO', entryType: 'clawback', amount: '-600.00', description: 'refund' });
      const res = await withdraw(leo);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.available_balance_cents).toBe(-10_000);
      expect((await balance(leo)).is_negative).toBe(true);
    });

    it('requires a complete payout profile (409)', async () => {
      const ana = await seedCreator(db, { slug: 'ANA', email: 'ana@creators.mx', speiClabe: null });
      await credit(ana, '500.00');
      const res = await withdraw(ana);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PAYOUT_PROFILE_INCOMPLETE');
    });

    it('pauses withdrawals for 24h after the payout CLABE is replaced', async () => {
      await setProfile(leo, { clabe: stpClabe() });
      const blocked = await withdraw(leo, { amount_cents: 10_000 });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toMatchObject({
        code: 'PAYOUT_ACCOUNT_COOLING_OFF',
        details: { withdrawals_available_at: '2026-10-27T18:00:00.000Z' },
      });
      clock.advance(24 * HOUR);
      const ok = await withdraw(leo, { amount_cents: 10_000 });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().destination).toMatchObject({ bank_code: '646', bank_name: 'STP' });
    });

    it('is idempotent per Idempotency-Key: a retry returns the original withdrawal and debits once', async () => {
      const headers = { 'idempotency-key': 'withdraw-2026-10-26-0001' };
      const first = await withdraw(leo, { amount_cents: 15_000 }, headers);
      const retry = await withdraw(leo, { amount_cents: 15_000 }, headers);
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().id).toBe(first.json().id);
      expect(await db.select().from(withdrawalRequests)).toHaveLength(1);
      expect((await balance(leo)).available_balance_cents).toBe(35_000);

      const bad = await withdraw(leo, { amount_cents: 15_000 }, { 'idempotency-key': 'no spaces!' });
      expect(bad.statusCode).toBe(400);
    });

    it('never overdraws under concurrent requests', async () => {
      const results = await Promise.all([1, 2, 3].map(() => withdraw(leo, { amount_cents: 30_000 })));
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
      expect(await db.select().from(withdrawalRequests)).toHaveLength(1);
      expect((await balance(leo)).available_balance_cents).toBe(20_000);
    });

    it('keeps an in-flight withdrawal pointed at the original account after a CLABE change', async () => {
      const w = (await withdraw(leo, { amount_cents: 10_000 })).json();
      await setProfile(leo, { clabe: stpClabe(), legal_name: 'Otra Persona' });
      const [row] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, w.id));
      expect(row).toMatchObject({ clabe: BANAMEX, bankCode: '002', beneficiaryName: 'Leonardo Méndez Ruiz' });
    });

    it('validates the body', async () => {
      for (const body of [{ amount_cents: 0 }, { amount_cents: 100.5 }, { amount_cents: -5 }, { amount: 100 }]) {
        expect((await withdraw(leo, body)).statusCode).toBe(400);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /v1/creators/me/withdrawals', () => {
    it('lists the creator’s own withdrawals, newest first', async () => {
      await setProfile(leo);
      await credit(leo, '1000.00');
      const first = (await withdraw(leo, { amount_cents: 10_000 })).json();
      clock.advance(HOUR);
      const second = (await withdraw(leo, { amount_cents: 20_000 })).json();

      const ana = await seedCreator(db, { slug: 'ANA', email: 'ana@creators.mx' });
      expect((await call(ana, 'GET', '/v1/creators/me/withdrawals')).json()).toEqual({ data: [] });

      const res = await call(leo, 'GET', '/v1/creators/me/withdrawals');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.json().data.map((w: { id: string }) => w.id)).toEqual([second.id, first.id]);
      expect(res.body).not.toContain(BANAMEX);
    });

    it('requires a creator API key', async () => {
      for (const url of ['/v1/creators/me/withdrawals', '/v1/creators/me/balance', '/v1/creators/me/payout-profile']) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      }
    });
  });
});
