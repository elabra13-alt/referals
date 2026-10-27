import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';
import { codes, ledgerEntries, payouts, sales, type Link } from '../src/db/schema.js';
import { signPayload } from '../src/modules/webhooks/signature.js';
import { TEST_ENCRYPTION_KEY, TEST_WEBHOOK_SECRET, TestClock, createTestDb, createTestRedis, seedLink, seedSeller } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

describe('order webhooks', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let sellerId: string;
  let link: Link;
  let codeSeq = 0;

  const insertCode = async (opts: { linkId?: string; expiresAt?: Date; status?: 'issued' | 'applied' | 'revoked' } = {}) => {
    const entropy = ['2345', '6789', 'ABCD', 'EFGH', 'JKMN', 'PQRS', 'TVWX'][codeSeq++ % 7];
    const [row] = await db
      .insert(codes)
      .values({
        linkId: opts.linkId ?? link.id,
        code: `REF-LEO-${entropy}`,
        buyerEmail: 'valeria@gmail.com',
        status: opts.status ?? 'issued',
        issuedAt: new Date(clock.now().getTime() - DAY),
        expiresAt: opts.expiresAt ?? new Date(clock.now().getTime() + DAY),
        autoApplyUrl: 'https://shop.example.mx/checkout',
      })
      .returning();
    return row!;
  };

  const paidPayload = (overrides: Record<string, unknown> = {}) => ({
    event: 'order.paid',
    seller_order_id: 'ORD-SHOP-9921',
    applied_discount_code: 'REF-LEO-8K2M',
    currency: 'MXN',
    financials: { gross_total: 1200.0, discount_total: 180.0, net_total: 1020.0 },
    customer: { email: 'valeria@gmail.com' },
    timestamp: clock.now().toISOString(),
    ...overrides,
  });

  const send = (
    path: 'paid' | 'refunded',
    payload: unknown,
    opts: { seller?: string; secret?: string; signature?: string; rawBody?: string } = {},
  ) => {
    const raw = opts.rawBody ?? JSON.stringify(payload);
    return app.inject({
      method: 'POST',
      url: `/v1/webhooks/orders/${path}`,
      headers: {
        'content-type': 'application/json',
        'x-referals-seller-id': opts.seller ?? sellerId,
        'x-referals-signature': opts.signature ?? signPayload(raw, opts.secret ?? TEST_WEBHOOK_SECRET),
      },
      payload: raw,
    });
  };

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-13T16:00:00.000Z'));
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, now: clock.now },
      { logger: false },
    );
    sellerId = (await seedSeller(db)).id;
    ({ link } = await seedLink(db, { sellerId }));
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  describe('POST /v1/webhooks/orders/paid', () => {
    it('attributes the sale, consumes the code and opens a 14-day beauty escrow payout', async () => {
      const code = await insertCode();
      const res = await send('paid', paidPayload({ applied_discount_code: code.code }));

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        status: 'processed',
        attribution: { attributed: true, reason: 'valid_code', code: code.code },
        payout: {
          amount: '153.00', // 15% of net 1020.00
          currency: 'MXN',
          commission_rate: '0.1500',
          platform_fee_rate: '0.0300',
          platform_fee_amount: '30.60', // 3% of net 1020.00, owed by the seller
          escrow_days: 14,
          escrow_until: '2026-10-27T16:00:00.000Z',
          status: 'in_escrow',
        },
      });

      const [sale] = await db.select().from(sales);
      expect(sale).toMatchObject({ id: body.sale_id, status: 'paid', attributed: true, codeId: code.id, netTotal: '1020.00' });
      const [updatedCode] = await db.select().from(codes).where(eq(codes.id, code.id));
      expect(updatedCode).toMatchObject({ status: 'applied', appliedAt: clock.now() });
    });

    it('is idempotent: a redelivery returns already_processed without a second sale or payout', async () => {
      const code = await insertCode();
      const first = (await send('paid', paidPayload({ applied_discount_code: code.code }))).json();
      const res = await send('paid', paidPayload({ applied_discount_code: code.code }));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'already_processed', sale_id: first.sale_id });
      expect(await db.select().from(sales)).toHaveLength(1);
      expect(await db.select().from(payouts)).toHaveLength(1);
    });

    it('creates exactly one sale under concurrent duplicate deliveries', async () => {
      const code = await insertCode();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => send('paid', paidPayload({ applied_discount_code: code.code }))),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 201]);
      const saleIds = new Set(results.map((r) => r.json().sale_id));
      expect(saleIds.size).toBe(1);
      expect(await db.select().from(payouts)).toHaveLength(1);
    });

    it('scopes seller_order_id per seller', async () => {
      const other = await seedSeller(db, 'whsec_other');
      const res1 = await send('paid', paidPayload({ applied_discount_code: null }));
      const res2 = await send('paid', paidPayload({ applied_discount_code: null }), { seller: other.id, secret: 'whsec_other' });
      expect([res1.statusCode, res2.statusCode]).toEqual([201, 201]);
      expect(res1.json().sale_id).not.toBe(res2.json().sale_id);
    });

    describe('14-day grace attribution window', () => {
      it('attributes a code that expired 13 days before the sale', async () => {
        const code = await insertCode({ expiresAt: new Date(clock.now().getTime() - 13 * DAY) });
        const res = await send('paid', paidPayload({ applied_discount_code: code.code }));
        expect(res.json().attribution).toEqual({ attributed: true, reason: 'grace_window', code: code.code });
        expect(res.json().payout.status).toBe('in_escrow');
      });

      it('attributes at exactly 14 days', async () => {
        const code = await insertCode({ expiresAt: new Date(clock.now().getTime() - 14 * DAY) });
        expect((await send('paid', paidPayload({ applied_discount_code: code.code }))).json().attribution.attributed).toBe(true);
      });

      it('records but does not attribute a code expired more than 14 days', async () => {
        const code = await insertCode({ expiresAt: new Date(clock.now().getTime() - 14 * DAY - 1000) });
        const res = await send('paid', paidPayload({ applied_discount_code: code.code }));
        expect(res.statusCode).toBe(201);
        expect(res.json()).toMatchObject({ attribution: { attributed: false, reason: 'code_expired' }, payout: null });
        const [row] = await db.select().from(codes).where(eq(codes.id, code.id));
        expect(row!.status).toBe('issued');
      });

      it('clamps a future-dated timestamp to receipt time', async () => {
        const code = await insertCode({ expiresAt: new Date(clock.now().getTime() - 10 * DAY) });
        const res = await send(
          'paid',
          paidPayload({ applied_discount_code: code.code, timestamp: new Date(clock.now().getTime() + 30 * DAY).toISOString() }),
        );
        expect(res.json().attribution.reason).toBe('grace_window');
        const [sale] = await db.select().from(sales);
        expect(sale!.orderedAt).toEqual(clock.now());
      });
    });

    it.each([
      ['electronics', 25, '2026-11-07T16:00:00.000Z'],
      ['fashion', 28, '2026-11-10T16:00:00.000Z'],
      ['home', 21, '2026-11-03T16:00:00.000Z'],
      ['mystery', 21, '2026-11-03T16:00:00.000Z'],
    ])('applies %s escrow of %i days', async (category, days, until) => {
      const { link: catLink } = await seedLink(db, { sellerId, category, linkSlug: `leo-${category}` });
      const code = await insertCode({ linkId: catLink.id });
      const payout = (await send('paid', paidPayload({ applied_discount_code: code.code }))).json().payout;
      expect(payout).toMatchObject({ escrow_days: days, escrow_until: until });
    });

    it('matches codes case-insensitively', async () => {
      const code = await insertCode();
      const res = await send('paid', paidPayload({ applied_discount_code: ` ${code.code.toLowerCase()} ` }));
      expect(res.json().attribution.attributed).toBe(true);
    });

    it('never pays out on another seller’s code', async () => {
      const code = await insertCode();
      const other = await seedSeller(db, 'whsec_other');
      const res = await send('paid', paidPayload({ applied_discount_code: code.code }), { seller: other.id, secret: 'whsec_other' });
      expect(res.json()).toMatchObject({ attribution: { attributed: false, reason: 'code_seller_mismatch' }, payout: null });
    });

    it('enforces single use: a second order with the same code is not attributed', async () => {
      const code = await insertCode();
      await send('paid', paidPayload({ applied_discount_code: code.code }));
      const res = await send('paid', paidPayload({ applied_discount_code: code.code, seller_order_id: 'ORD-SHOP-9922' }));
      expect(res.json()).toMatchObject({ attribution: { attributed: false, reason: 'code_already_used' }, payout: null });
      expect(await db.select().from(payouts)).toHaveLength(1);
    });

    it('lets only one of two concurrent orders consume a code', async () => {
      const code = await insertCode();
      const results = await Promise.all(
        ['ORD-A', 'ORD-B'].map((id) => send('paid', paidPayload({ applied_discount_code: code.code, seller_order_id: id }))),
      );
      expect(results.map((r) => r.json().attribution.attributed).sort()).toEqual([false, true]);
      expect(await db.select().from(payouts)).toHaveLength(1);
    });

    it.each([
      ['unknown code', 'REF-ZZZ-2222', 'code_not_found'],
      ['no code', null, 'no_code'],
    ])('records unattributed sales for %s', async (_label, appliedCode, reason) => {
      const res = await send('paid', paidPayload({ applied_discount_code: appliedCode }));
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ attribution: { attributed: false, reason }, payout: null });
    });

    describe('signature verification', () => {
      it.each([
        ['wrong secret', { secret: 'nope' }],
        ['missing signature', { signature: '' }],
        ['malformed signature', { signature: 'sha256=abc' }],
        ['unknown seller', { seller: '00000000-0000-4000-8000-000000000999' }],
        ['non-uuid seller', { seller: 'shop-1' }],
      ])('rejects %s with 401', async (_label, opts) => {
        const res = await send('paid', paidPayload(), opts);
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('INVALID_SIGNATURE');
        expect(await db.select().from(sales)).toHaveLength(0);
      });

      it('rejects a body modified after signing', async () => {
        const signed = JSON.stringify(paidPayload());
        const tampered = signed.replace('1020', '9020');
        const res = await send('paid', null, { rawBody: tampered, signature: signPayload(signed, TEST_WEBHOOK_SECRET) });
        expect(res.statusCode).toBe(401);
      });

      it('verifies the exact raw bytes (whitespace-sensitive formatting still passes)', async () => {
        const raw = JSON.stringify(paidPayload({ applied_discount_code: null }), null, 2);
        expect((await send('paid', null, { rawBody: raw })).statusCode).toBe(201);
      });
    });

    it.each([
      ['wrong event', { event: 'order.created' }],
      ['missing order id', { seller_order_id: '' }],
      ['3-decimal amount', { financials: { gross_total: 10.005, discount_total: 0, net_total: 10 } }],
      ['discount above gross', { financials: { gross_total: 100, discount_total: 150, net_total: 0 } }],
      ['negative net', { financials: { gross_total: 100, discount_total: 0, net_total: -1 } }],
      ['bad timestamp', { timestamp: 'yesterday' }],
    ])('rejects %s with 400', async (_label, overrides) => {
      const res = await send('paid', paidPayload(overrides));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a validly signed non-JSON body with 400', async () => {
      expect((await send('paid', null, { rawBody: 'not json' })).statusCode).toBe(400);
    });
  });

  describe('POST /v1/webhooks/orders/refunded', () => {
    const refundPayload = (overrides: Record<string, unknown> = {}) => ({
      event: 'order.refunded',
      seller_order_id: 'ORD-SHOP-9921',
      timestamp: clock.now().toISOString(),
      ...overrides,
    });

    it('marks the sale refunded and cancels the escrowed payout', async () => {
      const code = await insertCode();
      const paid = (await send('paid', paidPayload({ applied_discount_code: code.code }))).json();
      clock.advance(3 * DAY);

      const res = await send('refunded', refundPayload());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'processed',
        sale_id: paid.sale_id,
        sale_status: 'refunded',
        payouts: [{ payout_id: paid.payout.payout_id, status: 'cancelled', clawback: null }],
      });
      const [sale] = await db.select().from(sales);
      expect(sale).toMatchObject({ status: 'refunded', refundedAt: clock.now(), refundEvent: 'order.refunded' });
      const [payout] = await db.select().from(payouts);
      expect(payout).toMatchObject({ status: 'cancelled', cancelledAt: clock.now() });
    });

    it('handles chargebacks the same way', async () => {
      const code = await insertCode();
      await send('paid', paidPayload({ applied_discount_code: code.code }));
      const res = await send('refunded', refundPayload({ event: 'order.chargeback' }));
      expect(res.json().payouts[0].status).toBe('cancelled');
    });

    it('is idempotent', async () => {
      const code = await insertCode();
      const paid = (await send('paid', paidPayload({ applied_discount_code: code.code }))).json();
      await send('refunded', refundPayload());
      const res = await send('refunded', refundPayload());
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'already_processed', sale_id: paid.sale_id });
    });

    it('does not resurrect a refunded sale when order.paid is redelivered', async () => {
      const code = await insertCode();
      await send('paid', paidPayload({ applied_discount_code: code.code }));
      await send('refunded', refundPayload());
      const res = await send('paid', paidPayload({ applied_discount_code: code.code }));
      expect(res.json().status).toBe('already_processed');
      const [payout] = await db.select().from(payouts);
      expect(payout!.status).toBe('cancelled');
    });

    it('automatically claws back an already-released payout via a ledger debit', async () => {
      const code = await insertCode();
      await send('paid', paidPayload({ applied_discount_code: code.code }));
      await db.update(payouts).set({ status: 'released' });
      const res = await send('refunded', refundPayload());
      const [entry] = await db.select().from(ledgerEntries);
      expect(entry).toMatchObject({ entryType: 'clawback', amount: '-153.00', influencerSlug: 'leo' });
      expect(res.json().payouts).toEqual([
        expect.objectContaining({ status: 'clawed_back', clawback: { ledger_entry_id: entry!.id, amount: '-153.00', currency: 'MXN' } }),
      ]);
      const [sale] = await db.select().from(sales);
      expect(sale!.status).toBe('refunded');
    });

    it('refunds unattributed sales (no payout)', async () => {
      await send('paid', paidPayload({ applied_discount_code: null }));
      const res = await send('refunded', refundPayload());
      expect(res.json()).toMatchObject({ status: 'processed', payouts: [] });
    });

    it('returns 404 for an unknown order so the sender retries', async () => {
      const res = await send('refunded', refundPayload({ seller_order_id: 'ORD-NOPE' }));
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('SALE_NOT_FOUND');
    });

    it('cannot refund another seller’s order', async () => {
      await send('paid', paidPayload({ applied_discount_code: null }));
      const other = await seedSeller(db, 'whsec_other');
      const res = await send('refunded', refundPayload(), { seller: other.id, secret: 'whsec_other' });
      expect(res.statusCode).toBe(404);
    });

    it('rejects invalid signatures with 401', async () => {
      expect((await send('refunded', refundPayload(), { secret: 'nope' })).statusCode).toBe(401);
    });
  });

  describe('encrypted webhook secrets', () => {
    it('stores secrets encrypted at rest', async () => {
      const seller = await seedSeller(db, 'whsec_plain_value');
      expect(seller.webhookSecret).toMatch(/^v1:/);
      expect(seller.webhookSecret).not.toContain('whsec_plain_value');
    });

    it('still verifies legacy plaintext secrets until backfilled', async () => {
      const legacy = await seedSeller(db, 'whsec_legacy', { plaintext: true });
      const res = await send('paid', paidPayload({ applied_discount_code: null }), { seller: legacy.id, secret: 'whsec_legacy' });
      expect(res.statusCode).toBe(201);
    });

    it('rejects with 401 when the secret cannot be decrypted (wrong key / tampered row)', async () => {
      const otherKeyApp = buildApp(
        { db, redis: await createTestRedis(), webhookEncryptionKey: Buffer.alloc(32, 7), now: clock.now },
        { logger: false },
      );
      const raw = JSON.stringify(paidPayload({ applied_discount_code: null }));
      const res = await otherKeyApp.inject({
        method: 'POST',
        url: '/v1/webhooks/orders/paid',
        headers: {
          'content-type': 'application/json',
          'x-referals-seller-id': sellerId,
          'x-referals-signature': signPayload(raw, TEST_WEBHOOK_SECRET),
        },
        payload: raw,
      });
      await otherKeyApp.close();
      expect(res.statusCode).toBe(401);
    });
  });
});
