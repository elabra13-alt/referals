import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { creatorLoginTokens, creators } from '../../src/db/schema.js';
import { normalizeLoginPhone } from '../../src/modules/creators/portal-auth.service.js';
import { LOGIN_SENT_MESSAGE } from '../../src/modules/creators/portal-auth.template.js';
import { InMemoryWhatsAppOutbox } from '../../src/modules/notifications/whatsapp.service.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedCreator } from '../helpers.js';

type Creator = Awaited<ReturnType<typeof seedCreator>>;

const MINUTE = 60 * 1000;
const LEO_PHONE = '+525512345678';

describe('creator magic login (/c/login)', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let outbox: InMemoryWhatsAppOutbox;
  let leo: Creator;
  let ipCounter = 0;

  const cookieLine = (res: LightMyRequestResponse, name: string) => {
    const header = res.headers['set-cookie'];
    const lines = Array.isArray(header) ? header : header ? [header] : [];
    return lines.find((l) => l.startsWith(`${name}=`));
  };

  /** Loads the form: returns its pre-session cookie and CSRF token. */
  const openForm = async () => {
    const res = await app.inject({ method: 'GET', url: '/c/login' });
    expect(res.statusCode).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(res.body)![1]!;
    return { cookie: cookieLine(res, 'ref_login')!.split(';')[0]!, csrf, res };
  };

  /** Submits the form from its own IP unless one is given (so per-phone limits are isolated). */
  const submit = async (phone: string, opts: { ip?: string; csrf?: string; cookie?: string | null } = {}) => {
    const form = await openForm();
    return app.inject({
      method: 'POST',
      url: '/c/login',
      remoteAddress: opts.ip ?? `10.0.0.${++ipCounter}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(opts.cookie === null ? {} : { cookie: opts.cookie ?? form.cookie }),
      },
      payload: new URLSearchParams({ phone, csrf: opts.csrf ?? form.csrf }).toString(),
    });
  };

  /** Requests a link for the number and returns the token from the WhatsApp message. */
  const requestLink = async (phone = '5512345678') => {
    const before = outbox.messages.length;
    expect((await submit(phone)).statusCode).toBe(200);
    await vi.waitFor(() => expect(outbox.messages.length).toBe(before + 1));
    const url = new URL(outbox.messages[before]!.parameters[0]!);
    return { url, token: url.searchParams.get('token')! };
  };

  const verify = (token: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/c/login/verify?token=${token}`, headers });

  /** Lets background dispatches finish before asserting that nothing was sent. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-28T18:00:00.000Z'));
    outbox = new InMemoryWhatsAppOutbox();
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, whatsappProvider: outbox, now: clock.now },
      { logger: false },
    );
    leo = await seedCreator(db, { slug: 'LEO', phone: LEO_PHONE, whatsappOptInAt: new Date('2026-10-01T00:00:00.000Z') });
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  describe('login form', () => {
    it('renders a phone form with a CSRF token under a nonce CSP', async () => {
      const { res, csrf } = await openForm();
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('<input type="tel" id="phone" name="phone"');
      expect(res.body).toContain('>Enviarme enlace por WhatsApp</button>');
      expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookieLine(res, 'ref_login')).toMatch(/^ref_login=[A-Za-z0-9_-]{43}; Path=\/c\/login; Max-Age=1800; HttpOnly; Secure; SameSite=Lax$/);
      expect(res.body).not.toMatch(/gradient/i);

      const csp = res.headers['content-security-policy'] as string;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(res.body).toContain(`<style nonce="${nonce}">`);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('sends an already signed-in creator straight to the wallet', async () => {
      const { token } = await requestLink();
      const portal = cookieLine(await verify(token), 'ref_creator')!.split(';')[0]!;
      const res = await app.inject({ method: 'GET', url: '/c/login', headers: { cookie: portal } });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/c/wallet');
    });

    it('links the signed-out portal page to the login form', async () => {
      const res = await app.inject({ method: 'GET', url: '/c/wallet' });
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('href="/c/login"');
    });
  });

  // ---------------------------------------------------------------------------
  describe('phone normalization', () => {
    it.each([
      ['5512345678', LEO_PHONE],
      ['55 1234 5678', LEO_PHONE],
      ['(55) 1234-5678', LEO_PHONE],
      ['525512345678', LEO_PHONE],
      ['+52 55 1234 5678', LEO_PHONE],
      ['+5215512345678', LEO_PHONE], // legacy mobile prefix
      ['+14155550123', '+14155550123'],
    ])('%s → %s', (input, expected) => {
      expect(normalizeLoginPhone(input)).toBe(expected);
    });

    it.each(['', '12345', 'abc', '055 1234 5678', '+0123456789', '5'.repeat(41)])('rejects %j', (input) => {
      expect(normalizeLoginPhone(input)).toBeNull();
    });

    it('re-renders the form (400) for an unusable number without contacting anyone', async () => {
      const res = await submit('12-34');
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('role="alert"');
      expect(res.body).toContain('value="12-34"');
      await settle();
      expect(outbox.messages).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('CSRF', () => {
    it('rejects posts without the form cookie or with a foreign token', async () => {
      const other = await openForm();
      for (const opts of [{ cookie: null }, { csrf: 'x'.repeat(43) }, { csrf: other.csrf }, { cookie: 'ref_login=short' }]) {
        const res = await submit('5512345678', opts);
        expect(res.statusCode, JSON.stringify(opts)).toBe(403);
        expect(res.body).toContain('La página expiró');
      }
      await settle();
      expect(outbox.messages).toHaveLength(0);
      expect(await db.select().from(creatorLoginTokens)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('anti-enumeration', () => {
    it('answers unknown, not opted-in and suspended numbers exactly like a registered one', async () => {
      await seedCreator(db, { slug: 'MIA', email: 'mia@creators.mx', phone: '+525598765432' }); // no opt-in
      await seedCreator(db, {
        slug: 'SUS',
        email: 'sus@creators.mx',
        phone: '+525511112222',
        whatsappOptInAt: new Date('2026-10-01T00:00:00.000Z'),
        status: 'suspended',
      });

      const strip = (body: string) => body.replace(/nonce="[^"]+"/g, '');
      const bodies = new Set<string>();
      for (const phone of ['5512345678', '5500000000', '5598765432', '5511112222']) {
        const res = await submit(phone);
        expect(res.statusCode, phone).toBe(200);
        expect(res.body).toContain(LOGIN_SENT_MESSAGE);
        expect(cookieLine(res, 'ref_creator'), phone).toBeUndefined();
        bodies.add(strip(res.body));
      }
      expect(bodies.size).toBe(1);

      await vi.waitFor(() => expect(outbox.messages).toHaveLength(1));
      await settle();
      expect(outbox.messages).toHaveLength(1);
      expect(outbox.messages[0]!.to).toBe(LEO_PHONE);
      const tokens = await db.select().from(creatorLoginTokens);
      expect(tokens.map((t) => t.creatorId)).toEqual([leo.id]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('WhatsApp dispatch', () => {
    it('sends the portal_login template with a 15-minute, hashed-at-rest token', async () => {
      const { url, token } = await requestLink('+52 55 1234 5678');
      const message = outbox.messages[0]!;
      expect(message).toMatchObject({ to: LEO_PHONE, template: 'portal_login', language: 'es_MX' });
      expect(message.parameters).toHaveLength(1);
      expect(`${url.origin}${url.pathname}`).toBe('https://referals.mx/c/login/verify');
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(message.previewText).toBe(
        `Tu enlace de acceso seguro a Referals: ${url.href} (válido por 15 minutos). Si no lo solicitaste, puedes ignorar este mensaje.`,
      );

      const [row] = await db.select().from(creatorLoginTokens);
      expect(row).toMatchObject({
        creatorId: leo.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        usedAt: null,
        expiresAt: new Date(clock.now().getTime() + 15 * MINUTE),
      });
      expect(JSON.stringify(row)).not.toContain(token);
    });

    it('still confirms when WhatsApp is down (nothing leaks through the response)', async () => {
      outbox.failWith = new Error('Meta outage');
      const res = await submit('5512345678');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(LOGIN_SENT_MESSAGE);
      await vi.waitFor(async () => expect(await db.select().from(creatorLoginTokens)).toHaveLength(1));
    });
  });

  // ---------------------------------------------------------------------------
  describe('rate limiting', () => {
    it('allows 3 requests per phone per 15 minutes, across IPs', async () => {
      for (let i = 0; i < 3; i++) expect((await submit('5512345678')).statusCode).toBe(200);
      const blocked = await submit('55 1234 5678'); // same number, other format, fresh IP
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe(String(15 * 60));
      expect(blocked.body).toContain('Demasiados intentos');
      expect(blocked.body).toContain('<span class="num">15</span> minutos');
      await vi.waitFor(() => expect(outbox.messages).toHaveLength(3));

      // Another number is unaffected.
      expect((await submit('5500000000')).statusCode).toBe(200);
      clock.advance(15 * MINUTE);
      expect((await submit('5512345678')).statusCode).toBe(200);
    });

    it('allows 3 requests per IP per 15 minutes, across phones (registered or not)', async () => {
      const ip = '189.200.45.12';
      for (const phone of ['5500000001', '5500000002', '5500000003']) expect((await submit(phone, { ip })).statusCode).toBe(200);
      const blocked = await submit('5512345678', { ip });
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      await settle();
      expect(outbox.messages).toHaveLength(0); // Leo's request was blocked before any lookup

      expect((await submit('5512345678', { ip: '189.200.45.13' })).statusCode).toBe(200);
      clock.advance(15 * MINUTE);
      expect((await submit('5500000004', { ip })).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('verification', () => {
    it('exchanges the token for a 24h portal session and lands on the wallet', async () => {
      const { token } = await requestLink();
      const res = await verify(token);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/c/wallet');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      const cookie = cookieLine(res, 'ref_creator')!;
      expect(cookie).toMatch(
        new RegExp(`^ref_creator=${leo.id}\\.\\d+\\.[A-Za-z0-9_-]{43}; Path=/c; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$`),
      );

      const [row] = await db.select().from(creatorLoginTokens);
      expect(row!.usedAt).toEqual(clock.now());

      const wallet = await app.inject({ method: 'GET', url: '/c/wallet', headers: { cookie: cookie.split(';')[0]! } });
      expect(wallet.statusCode).toBe(200);
      expect(wallet.body).toContain('Mi Billetera');
    });

    it('is strictly single-use, even under concurrent clicks', async () => {
      const { token } = await requestLink();
      const results = await Promise.all([verify(token), verify(token), verify(token)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([303, 410, 410]);

      const again = await verify(token);
      expect(again.statusCode).toBe(410);
      expect(again.body).toContain('Este enlace ya no funciona');
      expect(again.body).toContain('href="/c/login"');
      expect(cookieLine(again, 'ref_creator')).toBeUndefined();
    });

    it('accepts a link until its 15 minutes are up, then answers 410', async () => {
      const first = await requestLink();
      clock.advance(15 * MINUTE);
      expect((await verify(first.token)).statusCode).toBe(303); // now == expires_at

      const second = await requestLink();
      clock.advance(15 * MINUTE + 1);
      const res = await verify(second.token);
      expect(res.statusCode).toBe(410);
      const [row] = await db.select().from(creatorLoginTokens).where(eq(creatorLoginTokens.tokenHash, createHash('sha256').update(second.token).digest('hex')));
      expect(row!.usedAt).toBeNull();
    });

    it('answers unknown and malformed tokens with a 401 page that links back to /c/login', async () => {
      for (const token of ['f'.repeat(64), 'nope', '', `${'a'.repeat(63)}G`]) {
        const res = await verify(token);
        expect(res.statusCode, token).toBe(401);
        expect(res.body).toContain('Enlace no válido');
        expect(res.body).toContain('href="/c/login"');
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      expect((await app.inject({ method: 'GET', url: '/c/login/verify' })).statusCode).toBe(401);
    });

    it('refuses creators suspended after the link was sent', async () => {
      const { token } = await requestLink();
      await db.update(creators).set({ status: 'suspended' }).where(eq(creators.id, leo.id));
      expect((await verify(token)).statusCode).toBe(401);
    });

    it('does not burn the token when WhatsApp fetches a link preview', async () => {
      const { token } = await requestLink();
      const preview = await verify(token, { 'user-agent': 'WhatsApp/2.24.1 A' });
      expect(preview.statusCode).toBe(200);
      expect(preview.headers['set-cookie']).toBeUndefined();
      expect((await db.select().from(creatorLoginTokens))[0]!.usedAt).toBeNull();
      expect((await verify(token, { 'user-agent': 'Mozilla/5.0 (iPhone)' })).statusCode).toBe(303);
    });
  });
});
