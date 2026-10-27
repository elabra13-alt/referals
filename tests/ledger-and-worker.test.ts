import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import type { Database } from '../src/db/client.js';
import { codes, ledgerEntries, payouts } from '../src/db/schema.js';
import { decryptSecret, encryptSecret, isEncryptedSecret, parseEncryptionKey } from '../src/lib/crypto.js';
import { decimalToCents, platformFeeCents } from '../src/lib/money.js';
import { EscrowWorkerService } from '../src/modules/escrow/escrow-worker.service.js';
import { LedgerRepository } from '../src/modules/ledger/ledger.repository.js';
import { LedgerService } from '../src/modules/ledger/ledger.service.js';
import { signPayload } from '../src/modules/webhooks/signature.js';
import { TEST_ENCRYPTION_KEY, TEST_WEBHOOK_SECRET, TestClock, createTestDb, createTestRedis, seedLink, seedSeller } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const silentLog = { info: () => undefined, error: () => undefined };

/** Drizzle wraps driver errors; surface the underlying Postgres message for assertions. */
const pgError = (p: Promise<unknown>) =>
  p.then(
    () => 'no error',
    (err: { cause?: { message?: string }; message?: string }) => err.cause?.message ?? err.message ?? '',
  );

describe('crypto (AES-256-GCM secrets at rest)', () => {
  const key = parseEncryptionKey('b'.repeat(64));

  it('round-trips and uses a fresh IV every time', () => {
    const a = encryptSecret('whsec_123', key);
    const b = encryptSecret('whsec_123', key);
    expect(a).not.toBe(b);
    expect(isEncryptedSecret(a)).toBe(true);
    expect(decryptSecret(a, key)).toBe('whsec_123');
  });

  it('detects tampering via the GCM auth tag', () => {
    const [v, iv, tag, ct] = encryptSecret('whsec_123', key).split(':');
    const flipped = Buffer.from(ct!, 'base64');
    flipped[0]! ^= 0x01;
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'), key)).toThrow();
  });

  it('fails with the wrong key or a different AAD context', () => {
    const enc = encryptSecret('whsec_123', key);
    expect(() => decryptSecret(enc, parseEncryptionKey('c'.repeat(64)))).toThrow();
    expect(() => decryptSecret(enc, key, 'other.column')).toThrow();
  });

  it('parses hex keys and stretches passphrases; rejects weak keys', () => {
    expect(parseEncryptionKey('0f'.repeat(32))).toEqual(Buffer.alloc(32, 0x0f));
    expect(parseEncryptionKey('x'.repeat(40))).toHaveLength(32);
    expect(() => parseEncryptionKey('short')).toThrow();
  });

  it('requires WEBHOOK_ENCRYPTION_KEY in production only', () => {
    const base = { DATABASE_URL: 'postgres://u:p@localhost/db', REDIS_URL: 'redis://localhost:6379' };
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/WEBHOOK_ENCRYPTION_KEY is required/);
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).WEBHOOK_ENCRYPTION_KEY).toHaveLength(32);
    expect(loadEnv({ ...base, NODE_ENV: 'production', WEBHOOK_ENCRYPTION_KEY: 'ab'.repeat(32) }).WEBHOOK_ENCRYPTION_KEY).toEqual(
      Buffer.alloc(32, 0xab),
    );
    expect(() => loadEnv({ ...base, WEBHOOK_ENCRYPTION_KEY: 'too-short' })).toThrow(/WEBHOOK_ENCRYPTION_KEY/);
  });

  it('treats an empty WEBHOOK_ENCRYPTION_KEY as unset', () => {
    const base = { DATABASE_URL: 'postgres://u:p@localhost/db', REDIS_URL: 'redis://localhost:6379', WEBHOOK_ENCRYPTION_KEY: '' };
    expect(loadEnv({ ...base, NODE_ENV: 'development' }).WEBHOOK_ENCRYPTION_KEY).toHaveLength(32);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/WEBHOOK_ENCRYPTION_KEY is required/);
  });

  it('boots from an unmodified .env.example, and in production only once secrets are filled in', () => {
    const example = Object.fromEntries(
      readFileSync('.env.example', 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(loadEnv(example).NODE_ENV).toBe('development');

    // What docker compose passes to the api/worker containers.
    const container = { ...example, NODE_ENV: 'production', DATABASE_URL: 'postgres://referals:referals_secret_pass@postgres:5432/referals_db', REDIS_URL: 'redis://redis:6379' };
    expect(() => loadEnv(container)).toThrow(/WEBHOOK_ENCRYPTION_KEY is required in production/);
    const env = loadEnv({ ...container, WEBHOOK_ENCRYPTION_KEY: 'ab'.repeat(32), ADMIN_API_TOKEN: 'cd'.repeat(32) });
    expect(env).toMatchObject({ NODE_ENV: 'production', DATABASE_URL: container.DATABASE_URL, ADMIN_API_TOKEN: 'cd'.repeat(32) });
  });
});

describe('money helpers', () => {
  it('computes the platform fee half-up', () => {
    expect(platformFeeCents(102000n, '0.0300')).toBe(3060n);
    expect(platformFeeCents(50n, '0.0300')).toBe(2n); // 1.5 -> 2
  });

  it('parses signed decimals', () => {
    expect(decimalToCents('-153.00')).toBe(-15300n);
    expect(decimalToCents('0.05')).toBe(5n);
  });
});

describe('escrow worker & influencer ledger', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let sellerId: string;
  let worker: EscrowWorkerService;
  let ledger: LedgerService;
  let seq = 0;

  /** Seeds a link (by category), issues a code and posts a signed order.paid for it. */
  const createSale = async (opts: { category?: string; influencer?: string; net?: number } = {}) => {
    const n = ++seq;
    const influencer = opts.influencer ?? 'leo';
    const { link } = await seedLink(db, {
      sellerId,
      influencerSlug: influencer,
      category: opts.category ?? 'beauty',
      linkSlug: `${influencer}-${n}`,
    });
    const entropy = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
    const code = `REF-${influencer.toUpperCase().slice(0, 5)}-${entropy[n % 30]}${entropy[(n * 7) % 30]}${entropy[(n * 13) % 30]}${entropy[(n * 17) % 30]}`;
    await db.insert(codes).values({
      linkId: link.id,
      code,
      buyerEmail: `buyer${n}@gmail.com`,
      issuedAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + 2 * DAY),
      autoApplyUrl: 'https://shop.example.mx/checkout',
    });
    const net = opts.net ?? 1020;
    const raw = JSON.stringify({
      event: 'order.paid',
      seller_order_id: `ORD-${n}`,
      applied_discount_code: code,
      currency: 'MXN',
      financials: { gross_total: net, discount_total: 0, net_total: net },
      timestamp: clock.now().toISOString(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/orders/paid',
      headers: {
        'content-type': 'application/json',
        'x-referals-seller-id': sellerId,
        'x-referals-signature': signPayload(raw, TEST_WEBHOOK_SECRET),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(201);
    return { orderId: `ORD-${n}`, payoutId: res.json().payout.payout_id as string, amount: res.json().payout.amount as string };
  };

  const refund = async (orderId: string, event = 'order.refunded') => {
    const raw = JSON.stringify({ event, seller_order_id: orderId, timestamp: clock.now().toISOString() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/orders/refunded',
      headers: {
        'content-type': 'application/json',
        'x-referals-seller-id': sellerId,
        'x-referals-signature': signPayload(raw, TEST_WEBHOOK_SECRET),
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const payoutStatus = async (id: string) => (await db.select().from(payouts).where(eq(payouts.id, id)))[0]!;

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-13T16:00:00.000Z'));
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, now: clock.now },
      { logger: false },
    );
    sellerId = (await seedSeller(db)).id;
    worker = new EscrowWorkerService({ db, log: silentLog, now: clock.now });
    ledger = new LedgerService(db);
  });

  afterEach(async () => {
    await worker.stop();
    await app.close();
    await closeDb();
  });

  it('does not release payouts before escrow_until', async () => {
    const sale = await createSale();
    clock.advance(14 * DAY - 1000);
    expect(await worker.runOnce()).toEqual({ released: 0, batches: 0 });
    expect((await payoutStatus(sale.payoutId)).status).toBe('in_escrow');
    expect((await ledger.getBalance('leo')).balances).toEqual([]);
  });

  it('releases matured payouts and credits the influencer ledger', async () => {
    const sale = await createSale();
    clock.advance(14 * DAY);

    expect(await worker.runOnce()).toEqual({ released: 1, batches: 1 });

    expect(await payoutStatus(sale.payoutId)).toMatchObject({ status: 'released', releasedAt: clock.now() });
    const entries = await ledger.getEntries('leo');
    expect(entries).toEqual([
      expect.objectContaining({ entryType: 'escrow_release', amount: '153.00', currency: 'MXN', payoutId: sale.payoutId }),
    ]);
    expect(await ledger.getBalance('leo')).toEqual({
      influencer_slug: 'leo',
      balances: [{ currency: 'MXN', balance: '153.00', entry_count: 1, is_negative: false }],
    });
  });

  it('is idempotent across repeated runs', async () => {
    await createSale();
    clock.advance(15 * DAY);
    await worker.runOnce();
    expect(await worker.runOnce()).toEqual({ released: 0, batches: 0 });
    expect(await db.select().from(ledgerEntries)).toHaveLength(1);
  });

  it('honours per-category escrow: beauty (14d) matures before fashion (28d)', async () => {
    const beauty = await createSale({ category: 'beauty' });
    const fashion = await createSale({ category: 'fashion' });
    clock.advance(20 * DAY);
    await worker.runOnce();
    expect((await payoutStatus(beauty.payoutId)).status).toBe('released');
    expect((await payoutStatus(fashion.payoutId)).status).toBe('in_escrow');
    clock.advance(8 * DAY);
    await worker.runOnce();
    expect((await payoutStatus(fashion.payoutId)).status).toBe('released');
  });

  it('drains in batches', async () => {
    worker = new EscrowWorkerService({ db, log: silentLog, now: clock.now, batchSize: 2 });
    for (let i = 0; i < 5; i++) await createSale();
    clock.advance(14 * DAY);
    expect(await worker.runOnce()).toEqual({ released: 5, batches: 3 });
    expect((await ledger.getBalance('leo')).balances[0]).toMatchObject({ balance: '765.00', entry_count: 5 });
  });

  it('never double-releases under concurrent runs', async () => {
    for (let i = 0; i < 4; i++) await createSale();
    clock.advance(14 * DAY);
    const other = new EscrowWorkerService({ db, log: silentLog, now: clock.now, batchSize: 1 });
    const [a, b] = await Promise.all([worker.runOnce(), other.runOnce()]);
    expect(a.released + b.released).toBe(4);
    expect(await db.select().from(ledgerEntries)).toHaveLength(4);
  });

  it('skips payouts cancelled by a refund during escrow', async () => {
    const sale = await createSale();
    clock.advance(5 * DAY);
    await refund(sale.orderId);
    clock.advance(10 * DAY);
    expect((await worker.runOnce()).released).toBe(0);
    expect((await payoutStatus(sale.payoutId)).status).toBe('cancelled');
    expect(await db.select().from(ledgerEntries)).toHaveLength(0);
  });

  it('claws back a released payout on a post-escrow refund, netting the balance to zero', async () => {
    const sale = await createSale();
    clock.advance(14 * DAY);
    await worker.runOnce();
    clock.advance(DAY);

    const res = await refund(sale.orderId, 'order.chargeback');

    expect(res.payouts).toEqual([
      { payout_id: sale.payoutId, status: 'clawed_back', clawback: expect.objectContaining({ amount: '-153.00' }) },
    ]);
    expect(await payoutStatus(sale.payoutId)).toMatchObject({ status: 'clawed_back', clawedBackAt: clock.now() });
    const types = (await ledger.getEntries('leo')).map((e) => [e.entryType, e.amount]);
    expect(types).toEqual([
      ['clawback', '-153.00'],
      ['escrow_release', '153.00'],
    ]);
    expect((await ledger.getBalance('leo')).balances[0]).toMatchObject({ balance: '0.00', is_negative: false });
  });

  it('lets the balance go negative when funds were already withdrawn', async () => {
    const sale = await createSale();
    clock.advance(14 * DAY);
    await worker.runOnce();
    // The creator cashed out the released 153.00.
    await new LedgerRepository(db).insertEntries([
      { influencerSlug: 'leo', entryType: 'withdrawal_adjustment', amount: '-153.00', currency: 'MXN', description: 'SPEI withdrawal' },
    ]);
    await refund(sale.orderId);

    expect((await ledger.getBalance('leo')).balances).toEqual([
      { currency: 'MXN', balance: '-153.00', entry_count: 3, is_negative: true },
    ]);
  });

  it('keeps balances isolated per influencer', async () => {
    await createSale({ influencer: 'leo' });
    await createSale({ influencer: 'ana', net: 500 });
    clock.advance(14 * DAY);
    await worker.runOnce();
    expect((await ledger.getBalance('leo')).balances[0]!.balance).toBe('153.00');
    expect((await ledger.getBalance('ana')).balances[0]!.balance).toBe('75.00');
  });

  it('records the platform fee on the payout without reducing the creator commission', async () => {
    const sale = await createSale();
    expect(await payoutStatus(sale.payoutId)).toMatchObject({
      amount: '153.00',
      platformFeeRate: '0.0300',
      platformFeeAmount: '30.60',
    });
  });

  describe('ledger integrity (database-enforced)', () => {
    let payoutId: string;

    beforeEach(async () => {
      payoutId = (await createSale()).payoutId;
      clock.advance(14 * DAY);
      await worker.runOnce();
    });

    it('rejects UPDATE and DELETE on ledger entries', async () => {
      expect(await pgError(db.update(ledgerEntries).set({ amount: '999.00' }))).toContain('append-only (UPDATE blocked)');
      expect(await pgError(db.delete(ledgerEntries))).toContain('append-only (DELETE blocked)');
      // withdrawal_requests references ledger_entries, so a plain TRUNCATE is already refused by the FK
      // check; TRUNCATE … CASCADE gets past that and must still be stopped by the append-only trigger.
      expect(await pgError(db.execute(sql`TRUNCATE ledger_entries`))).toMatch(
        /append-only \(TRUNCATE blocked\)|cannot truncate a table referenced in a foreign key constraint/,
      );
      expect(await pgError(db.execute(sql`TRUNCATE ledger_entries CASCADE`))).toContain('append-only (TRUNCATE blocked)');
      expect((await db.select().from(ledgerEntries))[0]!.amount).toBe('153.00');
    });

    it('rejects a second escrow_release for the same payout', async () => {
      expect(
        await pgError(
          new LedgerRepository(db).insertEntries([
            { influencerSlug: 'leo', payoutId, entryType: 'escrow_release', amount: '153.00', description: 'dup' },
          ]),
        ),
      ).toMatch(/ledger_payout_entry_type_unique/);
    });

    it('rejects wrongly-signed amounts', async () => {
      expect(
        await pgError(
          new LedgerRepository(db).insertEntries([
            { influencerSlug: 'leo', payoutId, entryType: 'clawback', amount: '153.00', description: 'positive clawback' },
          ]),
        ),
      ).toMatch(/ledger_amount_sign/);
    });
  });

  it('start() polls until stopped', async () => {
    await createSale();
    clock.advance(14 * DAY);
    worker.start(10);
    await expect.poll(async () => (await db.select().from(ledgerEntries)).length, { timeout: 5_000 }).toBe(1);
    await worker.stop();
  });
});
