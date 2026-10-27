import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { campaignInvitations, creators, links } from '../../src/db/schema.js';
import { creatorStorefrontItems } from '../../src/db/schema/storefront.js';
import { MagicSessions, generateMagicToken, hashMagicToken, magicTokenMatches } from '../../src/modules/creators/magic-link.js';
import { InMemoryWhatsAppOutbox } from '../../src/modules/notifications/whatsapp.service.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedAuthenticatedSeller, seedCreator } from '../helpers.js';

type Seller = Awaited<ReturnType<typeof seedAuthenticatedSeller>>;
type Creator = Awaited<ReturnType<typeof seedCreator>>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('magic-link invitation page (/c/invitations/:id)', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let outbox: InMemoryWhatsAppOutbox;
  let alice: Seller;
  let leo: Creator;
  let campaignId: string;

  const optedIn = (slug: string, phone: string) =>
    seedCreator(db, { slug, name: `Creator ${slug}`, phone, whatsappOptInAt: new Date('2026-10-01T00:00:00.000Z') });

  /** Sends an invitation and returns its id plus the path + query of the WhatsApp magic link. */
  const inviteAndGetLink = async (creator = leo, extra: Record<string, unknown> = {}) => {
    const before = outbox.messages.length;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaignId}/invitations`,
      headers: alice.authHeaders,
      payload: { creator_slug: creator.slug, ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    await vi.waitFor(() => expect(outbox.messages.length).toBe(before + 1));
    const url = new URL(outbox.messages[before]!.parameters[4]!);
    return { id: res.json().id as string, path: url.pathname, token: url.searchParams.get('token')!, invite: res };
  };

  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  /** A Set-Cookie line by cookie name (a magic link sets the invitation and the portal session). */
  const setCookie = (res: LightMyRequestResponse, name = 'ref_inv') => {
    const header = res.headers['set-cookie'];
    const lines = Array.isArray(header) ? header : header ? [header] : [];
    const line = lines.find((l) => l.startsWith(`${name}=`));
    expect(line, `${name} cookie`).toBeDefined();
    return line!;
  };
  const cookieFrom = (res: LightMyRequestResponse, name = 'ref_inv') => setCookie(res, name).split(';')[0]!;

  /** Opens the magic link and returns the session cookie it set. */
  const openSession = async (link: { path: string; token: string }) => {
    const res = await get(`${link.path}?token=${link.token}`);
    expect(res.statusCode).toBe(303);
    return cookieFrom(res);
  };

  const pageConfig = (html: string) => {
    const match = /<script type="application\/json" id="inv-config">([^<]*)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    return JSON.parse(match![1]!) as { respondPath: string; csrf: string; script: string };
  };

  const respond = (id: string, cookie: string | undefined, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/c/invitations/${id}/respond`,
      headers: cookie ? { cookie } : {},
      payload,
    });

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-26T18:00:00.000Z'));
    outbox = new InMemoryWhatsAppOutbox();
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, whatsappProvider: outbox, now: clock.now },
      { logger: false },
    );
    alice = await seedAuthenticatedSeller(db, 'Alice Beauty');
    leo = await optedIn('LEO', '+525512345678');
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
  describe('token generation & hashing', () => {
    it('stores only the SHA-256 of a 32-byte token and puts the raw token in the WhatsApp link', async () => {
      const link = await inviteAndGetLink();
      expect(link.path).toBe(`/c/invitations/${link.id}`);
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
      expect(Buffer.from(link.token, 'base64url')).toHaveLength(32);

      const [row] = await db.select().from(campaignInvitations).where(eq(campaignInvitations.id, link.id));
      expect(row!.magicTokenHash).toBe(createHash('sha256').update(link.token).digest('hex'));
      expect(JSON.stringify(row)).not.toContain(link.token);
    });

    it('never exposes the token or its hash through the seller or creator APIs', async () => {
      const link = await inviteAndGetLink();
      const hash = hashMagicToken(link.token);
      const bodies = [
        link.invite.body,
        (await app.inject({ method: 'GET', url: `/v1/campaigns/${campaignId}/invitations`, headers: alice.authHeaders })).body,
        (await app.inject({ method: 'GET', url: `/v1/campaigns/${campaignId}/matches`, headers: alice.authHeaders })).body,
        (await app.inject({ method: 'GET', url: '/v1/creators/me/invitations', headers: leo.authHeaders })).body,
      ];
      for (const body of bodies) {
        expect(body).not.toContain(link.token);
        expect(body).not.toContain(hash);
      }
    });

    it('uses a fresh token per invitation', async () => {
      const a = await inviteAndGetLink();
      const b = await inviteAndGetLink(await optedIn('MIA', '+525512345679'));
      expect(a.token).not.toBe(b.token);
    });

    it('compares tokens in constant time and rejects malformed input before hashing', () => {
      const { token, hash } = generateMagicToken();
      expect(magicTokenMatches(token, hash)).toBe(true);
      expect(magicTokenMatches(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, hash)).toBe(false);
      expect(magicTokenMatches(token, null)).toBe(false);
      expect(magicTokenMatches('short', hash)).toBe(false);
      expect(magicTokenMatches(token, 'not-a-hash')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('magic link verification → session cookie', () => {
    it('exchanges a valid token for an HttpOnly session scoped to the invitation and drops the token from the URL', async () => {
      const link = await inviteAndGetLink();
      const res = await get(`${link.path}?token=${link.token}`);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/c/invitations/${link.id}`);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      const cookie = setCookie(res);
      expect(cookie).toMatch(/^ref_inv=\d+\.[A-Za-z0-9_-]{43};/);
      expect(cookie).toContain(`Path=/c/invitations/${link.id}`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain(`Max-Age=${24 * 60 * 60}`);
      expect(cookie).not.toContain(link.token);
      const portal = setCookie(res, 'ref_creator');
      expect(portal).toMatch(new RegExp(`^ref_creator=${leo.id}\\.\\d+\\.[A-Za-z0-9_-]{43}; Path=/c; Max-Age=86400; HttpOnly; Secure; SameSite=Lax$`));

      const page = await get(link.path, cookieFrom(res));
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
    });

    it('rejects wrong, malformed and cross-invitation tokens with the same generic 401 page', async () => {
      const link = await inviteAndGetLink();
      const other = await inviteAndGetLink(await optedIn('MIA', '+525512345679'));
      const attempts = [
        `${link.path}?token=${generateMagicToken().token}`,
        `${link.path}?token=nope`,
        `${link.path}?token=`,
        `${link.path}?token=${other.token}`, // valid token, wrong invitation
        `/c/invitations/00000000-0000-4000-8000-000000000000?token=${link.token}`,
        `/c/invitations/not-a-uuid?token=${link.token}`,
      ];
      const bodies = new Set<string>();
      for (const url of attempts) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(401);
        expect(res.headers['set-cookie'], url).toBeUndefined();
        expect(res.body).toContain('Enlace no válido');
        bodies.add(res.body.replace(/nonce="[^"]+"/g, ''));
      }
      expect(bodies.size).toBe(1);
    });

    it('rejects a valid token once the invitation window has passed (410)', async () => {
      const link = await inviteAndGetLink();
      clock.advance(7 * DAY);
      const res = await get(`${link.path}?token=${link.token}`);
      expect(res.statusCode).toBe(410);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).toContain('Esta invitación venció');
    });

    it('rejects links for suspended creators', async () => {
      const link = await inviteAndGetLink();
      await db.update(creators).set({ status: 'suspended' }).where(eq(creators.id, leo.id));
      expect((await get(`${link.path}?token=${link.token}`)).statusCode).toBe(401);
    });

    it('re-sending rotates the token: the old link and its session stop working', async () => {
      const first = await inviteAndGetLink();
      const oldCookie = await openSession(first);
      clock.advance(8 * DAY);
      const second = await inviteAndGetLink(); // expired → re-sent
      expect(second.id).toBe(first.id);
      expect(second.token).not.toBe(first.token);

      expect((await get(`${first.path}?token=${first.token}`)).statusCode).toBe(401);
      expect((await get(first.path, oldCookie)).statusCode).toBe(401);
      expect((await get(second.path, await openSession(second))).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('session enforcement', () => {
    it('requires the session cookie to view the page', async () => {
      const link = await inviteAndGetLink();
      const res = await get(link.path);
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('Abre tu invitación desde WhatsApp');
      expect(res.body).not.toContain('Glow Serum');
    });

    it('rejects tampered, foreign and expired session cookies', async () => {
      const link = await inviteAndGetLink();
      const other = await inviteAndGetLink(await optedIn('MIA', '+525512345679'));
      const cookie = await openSession(link);
      const [name, value] = cookie.split('=') as [string, string];
      const [exp, sig] = value.split('.') as [string, string];

      expect((await get(link.path, `${name}=${Number(exp) + DAY}.${sig}`)).statusCode).toBe(401); // extended expiry
      expect((await get(link.path, `${name}=${exp}.${sig.slice(0, -2)}xx`)).statusCode).toBe(401);
      expect((await get(other.path, cookie)).statusCode).toBe(401); // session for another invitation
      // A session signed with another server key.
      const forged = new MagicSessions(Buffer.alloc(32, 7)).issue(
        { invitationId: link.id, creatorId: leo.id, magicTokenHash: hashMagicToken(link.token) },
        clock.now(),
      );
      expect((await get(link.path, `${name}=${forged.value}`)).statusCode).toBe(401);

      expect((await get(link.path, cookie)).statusCode).toBe(200);
      clock.advance(DAY);
      expect((await get(link.path, cookie)).statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('mobile page', () => {
    it('renders brand, product, payout, escrow, note, hooks and actions under a nonce CSP', async () => {
      const link = await inviteAndGetLink(leo, { custom_note: '¡Nos encantó tu contenido de skincare!' });
      const res = await get(link.path, await openSession(link));
      const html = res.body;

      expect(html).toContain('Alice Beauty te invita');
      expect(html).toContain('<h1>Glow Serum</h1>');
      expect(html).toMatch(/class="payout-amount num">Ganas \$97\.35 MXN por venta</);
      expect(html).toMatch(/class="escrow num">14 días de custodia garantizada</);
      expect(html).toContain('¡Nos encantó tu contenido de skincare!');
      for (const angle of ['Problema', 'Prueba', 'Oferta']) expect(html).toContain(`>${angle}</span>`);
      expect(html).toContain('>Copiar guion</button>');
      expect(html).toContain('>Aceptar y publicar en mi vitrina</button>');
      expect(html).toContain('>Declinar invitación</button>');
      expect(html).toMatch(/\.num\{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on\}/);
      expect(html).not.toMatch(/gradient/i);

      const csp = res.headers['content-security-policy'] as string;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("default-src 'none'");
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect(html).toContain(`<style nonce="${nonce}">`);
      expect(res.headers['cache-control']).toBe('no-store');

      const cfg = pageConfig(html);
      expect(cfg.respondPath).toBe(`/c/invitations/${link.id}/respond`);
      expect(cfg.script).toMatch(/^Guion · Glow Serum\n1\. Problema: .+\n.+\n2\. Prueba: .+\n.+\n3\. Oferta: /);
    });

    it('escapes seller-controlled text', async () => {
      const link = await inviteAndGetLink(leo, { custom_note: '</script><script>alert(1)</script><img src=x onerror=alert(1)>' });
      const html = (await get(link.path, await openSession(link))).body;
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });

  // ---------------------------------------------------------------------------
  describe('1-tap accept / decline', () => {
    it('accepts inline (JSON), enrolls the creator and returns the link and storefront', async () => {
      const link = await inviteAndGetLink();
      const cookie = await openSession(link);
      const { csrf } = pageConfig((await get(link.path, cookie)).body);

      const res = await respond(link.id, cookie, { action: 'accept', csrf });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ status: 'accepted', storefront_url: 'https://referals.mx/c/leo' });
      expect(body.link_url).toMatch(/^https:\/\/referals\.mx\/r\/[a-z0-9-]+$/);

      const [row] = await db.select().from(campaignInvitations).where(eq(campaignInvitations.id, link.id));
      expect(row).toMatchObject({ status: 'accepted', respondedAt: clock.now() });
      const [created] = await db.select().from(links).where(eq(links.campaignId, campaignId));
      expect(body.link_url.endsWith(`/${created!.linkSlug}`)).toBe(true);
      expect(await db.select().from(creatorStorefrontItems).where(eq(creatorStorefrontItems.creatorId, leo.id))).toHaveLength(1);

      // Repeat tap is idempotent; the page now opens in the celebration state.
      expect((await respond(link.id, cookie, { action: 'accept', csrf })).json().status).toBe('already_accepted');
      const page = (await get(link.path, cookie)).body;
      expect(page).toContain('class="card state celebrate" id="inv-accepted"');
      expect(page).toContain(body.link_url);
      expect(page).toContain('href="https://referals.mx/c/leo"');
      expect(page).toContain('class="card state actions hidden" id="inv-actions"');
    });

    it('works without JavaScript: the form post redirects back to the celebration state', async () => {
      const link = await inviteAndGetLink();
      const cookie = await openSession(link);
      const { csrf } = pageConfig((await get(link.path, cookie)).body);

      const res = await app.inject({
        method: 'POST',
        url: `/c/invitations/${link.id}/respond`,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ action: 'accept', csrf }).toString(),
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/c/invitations/${link.id}`);
      expect((await get(link.path, cookie)).body).toContain('class="card state celebrate" id="inv-accepted"');
    });

    it('declines', async () => {
      const link = await inviteAndGetLink();
      const cookie = await openSession(link);
      const { csrf } = pageConfig((await get(link.path, cookie)).body);

      const res = await respond(link.id, cookie, { action: 'decline', csrf });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'declined' });
      const [row] = await db.select().from(campaignInvitations).where(eq(campaignInvitations.id, link.id));
      expect(row!.status).toBe('declined');
      expect(await db.select().from(links)).toHaveLength(0);
      expect((await get(link.path, cookie)).body).toContain('class="card state" id="inv-declined"');
    });

    it('requires a session and a matching CSRF token', async () => {
      const link = await inviteAndGetLink();
      const cookie = await openSession(link);
      const { csrf } = pageConfig((await get(link.path, cookie)).body);

      const noSession = await respond(link.id, undefined, { action: 'accept', csrf });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.json().error.code).toBe('SESSION_EXPIRED');
      const badCsrf = await respond(link.id, cookie, { action: 'accept', csrf: 'x'.repeat(43) });
      expect(badCsrf.statusCode).toBe(403);
      expect(badCsrf.json().error.code).toBe('CSRF_TOKEN_INVALID');
      expect((await respond(link.id, cookie, { action: 'accept' })).statusCode).toBe(400);
      expect((await respond(link.id, cookie, { action: 'delete', csrf })).statusCode).toBe(400);

      const [row] = await db.select().from(campaignInvitations).where(eq(campaignInvitations.id, link.id));
      expect(row!.status).toBe('pending');
    });

    it('refuses to accept once the invitation expires during the session', async () => {
      const link = await inviteAndGetLink();
      clock.advance(7 * DAY - HOUR);
      const cookie = await openSession(link);
      const { csrf } = pageConfig((await get(link.path, cookie)).body);
      clock.advance(2 * HOUR);

      const res = await respond(link.id, cookie, { action: 'accept', csrf });
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('INVITATION_EXPIRED');
      expect(await db.select().from(links)).toHaveLength(0);
      expect((await get(link.path, cookie)).body).toContain('Esta invitación venció');
    });
  });
});
