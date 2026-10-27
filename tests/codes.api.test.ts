import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';
import { codes } from '../src/db/schema.js';
import type { BackupDelivery } from '../src/modules/codes/backup-delivery.js';
import { CODE_PATTERN } from '../src/modules/codes/code-generator.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedLink } from './helpers.js';

const HOUR = 60 * 60 * 1000;

const body = (overrides: { link_slug?: string; buyer?: Record<string, unknown>; client_context?: Record<string, unknown> } = {}) => ({
  link_slug: overrides.link_slug ?? 'leo-glow-serum',
  buyer: overrides.buyer ?? { email: 'valeria@gmail.com', phone: '+5215512345678', send_whatsapp_backup: false },
  client_context: overrides.client_context ?? {
    fingerprint: 'a1b2c3d4e5f6',
    user_agent: 'Mozilla/5.0',
    ip_address: '189.200.45.12',
  },
});

describe('POST /v1/codes/request', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let enqueue: ReturnType<typeof vi.fn<BackupDelivery['enqueue']>>;
  let ipCounter = 0;

  /** Each call uses a fresh IP unless one is given, so the rate limiter stays out of the way. */
  const request = (payload: unknown, ip = `10.0.0.${++ipCounter}`) =>
    app.inject({ method: 'POST', url: '/v1/codes/request', payload: payload as object, remoteAddress: ip });

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    const redis = await createTestRedis();
    clock = new TestClock();
    enqueue = vi.fn<BackupDelivery['enqueue']>().mockResolvedValue(undefined);
    app = buildApp(
      {
        db,
        redis,
        webhookEncryptionKey: TEST_ENCRYPTION_KEY,
        now: clock.now,
        generatorOptions: { now: clock.now },
        shieldOptions: { now: clock.nowMs },
        backupDelivery: () => ({ enqueue }),
      },
      { logger: false },
    );
    await seedLink(db);
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  it('issues a branded single-use code instantly with an auto-apply URL (201)', async () => {
    const res = await request(body());
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');

    const json = res.json();
    expect(json.code).toMatch(CODE_PATTERN);
    expect(json.code).toMatch(/^REF-LEO-/);
    expect(json.status).toBe('issued');
    expect(json.issued_at).toBe(clock.now().toISOString());
    expect(Date.parse(json.expires_at) - Date.parse(json.issued_at)).toBe(48 * HOUR);
    expect(json.auto_apply_url).toBe(
      `https://shop.example.mx/checkout?discount=${json.code}&utm_source=referals&utm_campaign=LEO`,
    );
    expect(json.delivery).toEqual({ whatsapp_backup: 'not_requested' });

    const [row] = await db.select().from(codes);
    expect(row).toMatchObject({
      code: json.code,
      buyerEmail: 'valeria@gmail.com',
      buyerPhone: '+5215512345678',
      status: 'issued',
      renewalCount: 0,
    });
  });

  it('normalizes email casing and phone formatting before storing', async () => {
    const res = await request(body({ buyer: { email: '  Valeria@Gmail.COM ', phone: '+52 1 55-1234-5678' } }));
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(codes);
    expect(row).toMatchObject({ buyerEmail: 'valeria@gmail.com', buyerPhone: '+5215512345678' });
  });

  describe('duplicate guard (24h)', () => {
    it('returns 409 with the existing active code for the same email', async () => {
      const first = (await request(body())).json();
      const res = await request(body({ buyer: { email: 'valeria@gmail.com' } }));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: { code: 'ACTIVE_CODE_EXISTS', message: expect.any(String) },
        existing_code: {
          code: first.code,
          status: 'issued',
          issued_at: first.issued_at,
          expires_at: first.expires_at,
          auto_apply_url: first.auto_apply_url,
        },
      });
      expect(await db.select().from(codes)).toHaveLength(1);
    });

    it('matches on phone even when the email differs', async () => {
      const first = (await request(body())).json();
      const res = await request(body({ buyer: { email: 'other@gmail.com', phone: '+5215512345678' } }));
      expect(res.statusCode).toBe(409);
      expect(res.json().existing_code.code).toBe(first.code);
    });

    it('is scoped per link', async () => {
      await seedLink(db, { linkSlug: 'ana-glow-serum', influencerSlug: 'ana' });
      await request(body());
      const res = await request(body({ link_slug: 'ana-glow-serum' }));
      expect(res.statusCode).toBe(201);
      expect(res.json().code).toMatch(/^REF-ANA-/);
    });

    it('allows a new code once the previous one is older than 24h', async () => {
      const first = (await request(body())).json();
      clock.advance(24 * HOUR + 1);
      const res = await request(body());
      expect(res.statusCode).toBe(201);
      expect(res.json().code).not.toBe(first.code);
    });

    it('ignores codes that are no longer in issued status', async () => {
      await request(body());
      await db.update(codes).set({ status: 'applied' });
      expect((await request(body())).statusCode).toBe(201);
    });

    it('lets concurrent double-submits issue exactly one code', async () => {
      const results = await Promise.all([request(body()), request(body()), request(body())]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([201, 409, 409]);
      const issued = results.find((r) => r.statusCode === 201)!.json().code;
      for (const r of results.filter((x) => x.statusCode === 409)) expect(r.json().existing_code.code).toBe(issued);
      expect(await db.select().from(codes)).toHaveLength(1);
    });
  });

  describe('IP rate limiting', () => {
    it('rejects the 6th request within 60 minutes with 429 + Retry-After', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await request(body({ buyer: { email: `buyer${i}@gmail.com` } }), '189.200.45.12');
        expect(res.statusCode).toBe(201);
      }
      const res = await request(body({ buyer: { email: 'buyer6@gmail.com' } }), '189.200.45.12');
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('3600');
      expect(res.json().error.code).toBe('RATE_LIMITED');
    });

    it('keys on the server-observed IP, not the spoofable client_context.ip_address', async () => {
      for (let i = 0; i < 5; i++) {
        await request(
          body({ buyer: { email: `b${i}@gmail.com` }, client_context: { ip_address: `8.8.8.${i}` } }),
          '189.200.45.12',
        );
      }
      const res = await request(body({ buyer: { email: 'b6@gmail.com' }, client_context: { ip_address: '9.9.9.9' } }), '189.200.45.12');
      expect(res.statusCode).toBe(429);
    });

    it('counts invalid requests toward the limit', async () => {
      for (let i = 0; i < 5; i++) await request({}, '189.200.45.12');
      expect((await request(body(), '189.200.45.12')).statusCode).toBe(429);
    });
  });

  it('rejects disposable emails with 422', async () => {
    const res = await request(body({ buyer: { email: 'temp@mailinator.com' } }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('DISPOSABLE_EMAIL');
    expect(await db.select().from(codes)).toHaveLength(0);
  });

  it('returns 404 for an unknown link', async () => {
    const res = await request(body({ link_slug: 'nope' }));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('LINK_NOT_FOUND');
  });

  it.each([
    ['paused link', { linkStatus: 'paused' }],
    ['inactive product', { productStatus: 'archived' as const }],
    ['expired link', { linkExpiresAt: new Date('2026-10-01T00:00:00Z') }],
  ])('returns 410 for a %s', async (_label, opts) => {
    await seedLink(db, { linkSlug: 'dead-link', ...opts });
    const res = await request(body({ link_slug: 'dead-link' }));
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('LINK_INACTIVE');
  });

  it.each([
    ['missing buyer contact', body({ buyer: {} })],
    ['invalid email', body({ buyer: { email: 'not-an-email' } })],
    ['non-E.164 phone', body({ buyer: { phone: '5512345678' } })],
    ['whatsapp backup without phone', body({ buyer: { email: 'v@gmail.com', send_whatsapp_backup: true } })],
    ['missing link_slug', { buyer: { email: 'v@gmail.com' } }],
  ])('returns 400 for %s', async (_label, payload) => {
    const res = await request(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('queues the WhatsApp backup asynchronously without blocking the response', async () => {
    const res = await request(body({ buyer: { phone: '+5215512345678', send_whatsapp_backup: true } }));
    expect(res.statusCode).toBe(201);
    expect(res.json().delivery).toEqual({ whatsapp_backup: 'queued' });
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', to: '+5215512345678', code: res.json().code }),
    );
  });

  it('still returns 201 when the backup channel fails', async () => {
    enqueue.mockRejectedValue(new Error('provider down'));
    const res = await request(body({ buyer: { phone: '+5215512345678', send_whatsapp_backup: true } }));
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled());
  });
});
