import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { campaignInvitations, campaigns } from '../../src/db/schema.js';
import { SellerSessions } from '../../src/modules/sellers/seller-session.js';
import { InMemoryWhatsAppOutbox } from '../../src/modules/notifications/whatsapp.service.js';
import { signPayload } from '../../src/modules/webhooks/signature.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedAuthenticatedSeller, seedCreator } from '../helpers.js';

type Seller = Awaited<ReturnType<typeof seedAuthenticatedSeller>>;

const DAY = 24 * 60 * 60 * 1000;
const ADMIN_TOKEN = 'admin-token-for-dashboard-tests-0001';
const PHOTO = 'https://cdn.glowshop.mx/serum.jpg';
const OPT_IN = new Date('2026-10-01T00:00:00.000Z');

describe('seller dashboard (/seller/dashboard)', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let outbox: InMemoryWhatsAppOutbox;
  let alice: Seller;
  let bob: Seller;
  let campaignId: string;
  let productId: string;
  let ipCounter = 0;

  const api = (seller: Seller, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: seller.authHeaders, ...(payload ? { payload } : {}) });

  const cookieLine = (res: LightMyRequestResponse, name: string) => {
    const header = res.headers['set-cookie'];
    const lines = Array.isArray(header) ? header : header ? [header] : [];
    return lines.find((l) => l.startsWith(`${name}=`));
  };

  /** Opens the sign-in form: its pre-session cookie and CSRF token. */
  const openLogin = async () => {
    const res = await app.inject({ method: 'GET', url: '/seller/login' });
    expect(res.statusCode).toBe(200);
    return { cookie: cookieLine(res, 'ref_seller_login')!.split(';')[0]!, csrf: /name="csrf" value="([^"]+)"/.exec(res.body)![1]!, res };
  };

  const postLogin = async (fields: Record<string, string>, opts: { ip?: string; csrf?: string } = {}) => {
    const form = await openLogin();
    return app.inject({
      method: 'POST',
      url: '/seller/login',
      remoteAddress: opts.ip ?? `10.1.0.${++ipCounter}`,
      headers: { cookie: form.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf: opts.csrf ?? form.csrf, ...fields }).toString(),
    });
  };

  /** Signs in with the API key and returns the `ref_seller=…` cookie pair. */
  const signIn = async (seller = alice) => {
    const res = await postLogin({ api_key: seller.apiKey });
    expect(res.statusCode, res.body).toBe(303);
    return cookieLine(res, 'ref_seller')!.split(';')[0]!;
  };

  const dashboard = (cookie: string, query = '') => app.inject({ method: 'GET', url: `/seller/dashboard${query}`, headers: { cookie } });
  const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  /** One matchmaker card's markup (cards contain nested <li> tags, so cut at the next card). */
  const matchCard = (html: string, slug: string) => {
    const start = html.indexOf(`<li class="match" id="match-${slug}"`);
    expect(start, slug).toBeGreaterThan(-1);
    const next = html.indexOf('<li class="match"', start + 1);
    return html.slice(start, next === -1 ? html.indexOf('</aside>', start) : next);
  };

  const inviteJson = (cookie: string, payload: object) =>
    app.inject({ method: 'POST', url: '/seller/dashboard/invite', headers: { cookie, accept: 'application/json' }, payload });

  const createCampaign = async (seller: Seller, product: Record<string, unknown>, campaign: Record<string, unknown> = {}) => {
    const p = await api(seller, 'POST', '/v1/products', {
      price: 649,
      margin: 200,
      checkout_base_url: 'https://glowshop.mx/checkout',
      category: 'beauty',
      ...product,
    });
    expect(p.statusCode, p.body).toBe(201);
    const c = await api(seller, 'POST', '/v1/campaigns', { product_id: p.json().id, commission_rate: 0.15, ...campaign });
    expect(c.statusCode, c.body).toBe(201);
    return { productId: p.json().id as string, campaignId: c.json().id as string };
  };

  /** Issues a link, a coupon and a paid webhook: one attributed sale for the seller. */
  const attributedSale = async (seller: Seller, campaign: string, creatorSlug: string, orderId: string, netTotal: number) => {
    const link = await api(seller, 'POST', `/v1/campaigns/${campaign}/links`, { creator_slug: creatorSlug });
    expect([200, 201]).toContain(link.statusCode);
    const code = (
      await app.inject({
        method: 'POST',
        url: '/v1/codes/request',
        payload: { link_slug: link.json().link.link_slug, buyer: { email: `${orderId.toLowerCase()}@gmail.com` } },
        remoteAddress: `10.9.0.${++ipCounter}`,
      })
    ).json().code as string;
    const raw = JSON.stringify({
      event: 'order.paid',
      seller_order_id: orderId,
      applied_discount_code: code,
      currency: 'MXN',
      financials: { gross_total: netTotal, discount_total: 0, net_total: netTotal },
      timestamp: clock.now().toISOString(),
    });
    const paid = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/orders/paid',
      headers: { 'content-type': 'application/json', 'x-referals-seller-id': seller.seller.id, 'x-referals-signature': signPayload(raw, seller.webhookSecret) },
      payload: raw,
    });
    expect(paid.statusCode, paid.body).toBeLessThan(300);
  };

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-28T18:00:00.000Z'));
    outbox = new InMemoryWhatsAppOutbox();
    app = buildApp(
      {
        db,
        redis: await createTestRedis(),
        webhookEncryptionKey: TEST_ENCRYPTION_KEY,
        whatsappProvider: outbox,
        adminApiToken: ADMIN_TOKEN,
        now: clock.now,
      },
      { logger: false },
    );
    alice = await seedAuthenticatedSeller(db, 'Alice Beauty');
    bob = await seedAuthenticatedSeller(db, 'Bob Gadgets');
    ({ productId, campaignId } = await createCampaign(alice, { name: 'Glow Serum', image_url: PHOTO }, { is_public_catalog: true }));

    await seedCreator(db, {
      slug: 'LEO',
      name: 'Leo Glow',
      niche: 'beauty',
      followersCount: 25_000,
      engagementRate: '0.0800',
      avatarUrl: 'https://cdn.referals.mx/leo.jpg',
      instagramHandle: '@leoglow',
      tiktokHandle: '@leo.tt',
      isVerified: true,
      phone: '+525512345678',
      whatsappOptInAt: OPT_IN,
    });
    await seedCreator(db, {
      slug: 'MIA',
      name: 'Mia Ruiz',
      niche: 'fashion',
      followersCount: 4_000,
      avatarUrl: 'http://insecure.example/mia.jpg', // not https → initials
    });
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  describe('seller session', () => {
    it('sends signed-out visitors to the sign-in form', async () => {
      const res = await app.inject({ method: 'GET', url: '/seller/dashboard' });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/seller/login');

      const { res: form } = await openLogin();
      expect(form.body).toContain('<input type="password" id="api_key" name="api_key"');
      expect(cookieLine(form, 'ref_seller_login')).toMatch(/^ref_seller_login=[A-Za-z0-9_-]{43}; Path=\/seller\/login; Max-Age=1800; HttpOnly; Secure; SameSite=Strict$/);
      expect(form.headers['content-security-policy']).toContain("form-action 'self'");
    });

    it('exchanges a valid API key for an HttpOnly ref_seller cookie scoped to /seller', async () => {
      const res = await postLogin({ api_key: alice.apiKey });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/seller/dashboard');
      expect(cookieLine(res, 'ref_seller')).toMatch(
        new RegExp(`^ref_seller=${alice.seller.id}\\.\\d+\\.[A-Za-z0-9_-]{43}; Path=/seller; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$`),
      );
      expect(cookieLine(res, 'ref_seller')).not.toContain(alice.apiKey);
      expect((await dashboard(cookieLine(res, 'ref_seller')!.split(';')[0]!)).statusCode).toBe(200);
    });

    it('answers every failed sign-in with the same generic 401', async () => {
      const attempts: Record<string, string>[] = [
        { api_key: 'ref_live_wrong' },
        { api_key: `ref_live_${'x'.repeat(40)}` },
        { api_key: 'not-a-key' },
        { admin_token: 'wrong', seller_id: alice.seller.id },
        { admin_token: ADMIN_TOKEN, seller_id: '00000000-0000-4000-8000-000000000000' },
        { admin_token: ADMIN_TOKEN, seller_id: 'nope' },
      ];
      for (const fields of attempts) {
        const res = await postLogin(fields);
        expect(res.statusCode, JSON.stringify(fields)).toBe(401);
        expect(res.body).toContain('No pudimos iniciar sesión con esos datos.');
        expect(cookieLine(res, 'ref_seller')).toBeUndefined();
      }
    });

    it('lets the platform operator sign in as a seller with the admin token', async () => {
      const res = await postLogin({ admin_token: ADMIN_TOKEN, seller_id: bob.seller.id });
      expect(res.statusCode).toBe(303);
      const html = (await dashboard(cookieLine(res, 'ref_seller')!.split(';')[0]!)).body;
      expect(html).toContain('<strong>Bob Gadgets</strong>');
    });

    it('requires the sign-in form CSRF token', async () => {
      const res = await postLogin({ api_key: alice.apiKey }, { csrf: 'x'.repeat(43) });
      expect(res.statusCode).toBe(403);
      expect(cookieLine(res, 'ref_seller')).toBeUndefined();
    });

    it('rate-limits sign-in attempts per IP (10 per 15 minutes)', async () => {
      const ip = '189.200.45.12';
      for (let i = 0; i < 10; i++) expect((await postLogin({ api_key: 'ref_live_wrong' }, { ip })).statusCode).toBe(401);
      const blocked = await postLogin({ api_key: alice.apiKey }, { ip });
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(cookieLine(blocked, 'ref_seller')).toBeUndefined();
      expect((await postLogin({ api_key: alice.apiKey }, { ip: '189.200.45.13' })).statusCode).toBe(303);
    });

    it('rejects tampered, foreign-key and expired sessions; rotating the API key signs browsers out', async () => {
      const cookie = await signIn();
      const [name, value] = cookie.split('=') as [string, string];
      const [id, exp, sig] = value.split('.') as [string, string, string];
      const signedOut = async (c: string) => expect((await dashboard(c)).headers.location).toBe('/seller/login');

      await signedOut(`${name}=${id}.${Number(exp) + DAY}.${sig}`);
      await signedOut(`${name}=${bob.seller.id}.${exp}.${sig}`);
      const forged = new SellerSessions(Buffer.alloc(32, 7)).issue({ id: alice.seller.id, apiKeyHash: null }, clock.now());
      await signedOut(`${name}=${forged.value}`);

      expect((await dashboard(cookie)).statusCode).toBe(200);
      await api(alice, 'POST', '/v1/seller/api-key/rotate');
      await signedOut(cookie);

      clock.advance(12 * 60 * 60 * 1000);
      await signedOut(cookie);
    });

    it('signs out', async () => {
      const cookie = await signIn();
      const html = (await dashboard(cookie)).body;
      const res = await app.inject({
        method: 'POST',
        url: '/seller/logout',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `csrf=${encodeURIComponent(csrfOf(html))}`,
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/seller/login');
      expect(cookieLine(res, 'ref_seller')).toBe('ref_seller=; Path=/seller; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    });
  });

  // ---------------------------------------------------------------------------
  describe('dashboard page', () => {
    it('renders header, KPIs, campaigns and the matchmaker under a nonce CSP with the Solid Slate tokens', async () => {
      const res = await dashboard(await signIn());
      const html = res.body;
      expect(res.statusCode).toBe(200);

      expect(html).toContain('<strong>Alice Beauty</strong><span class="store-domain">glowshop.mx</span>');
      expect(html).toContain('id="quota-badge" data-slots="badge">25 / 25 Slots Activos</span>');
      expect(html).toContain('<span class="kpi-value num" id="kpi-gmv">$0.00 MXN</span>');
      expect(html).toContain('<span class="kpi-value num" id="kpi-slots" data-slots="kpi">25 / 25</span>');
      expect(html).toContain('class="kpi kpi-gmv"');
      expect(html).toContain('class="kpi kpi-creators"');

      // Tokens, no gradients, tabular numerals.
      for (const token of ['--canvas:#F8FAFC', '--line:#E2E8F0', '--onyx:#0F141C', '--body:#334155', '--cyan:#00B4D8', '--mint:#10B981', '--berry:#D62976', '--coral:#FE2C55', '--amber:#F59E0B']) {
        expect(html).toContain(token);
      }
      expect(html).toContain('grid-template-columns:minmax(0,3fr) minmax(0,2fr)');
      expect(html).toMatch(/\.num\{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on\}/);
      expect(html).not.toMatch(/gradient/i);

      const csp = res.headers['content-security-policy'] as string;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("img-src 'self' data: https:");
      expect(html).toContain(`<style nonce="${nonce}">`);
      expect(html).toContain(`<script nonce="${nonce}">`);
      expect(res.headers['cache-control']).toBe('no-store');

      // Campaign row: photo, commission, buyer discount (none without Shopify), catalog status.
      expect(html).toContain(`<img class="thumb" src="${PHOTO}" alt="Glow Serum"`);
      expect(html).toMatch(/<td class="num">15%<\/td>\s*<td class="num">—<\/td>\s*<td><span class="pill pill-mint">Público<\/span><\/td>/);
      expect(html).toContain(`<tr aria-current="true" data-campaign="${campaignId}">`);
      expect(html).toContain('>+ Lanzar nueva campaña</summary>');
    });

    it('renders matchmaker cards with avatar, handles, cyan score, tags and payout', async () => {
      const html = (await dashboard(await signIn())).body;
      const leo = matchCard(html, 'LEO');

      expect(leo).toContain('<img class="avatar" src="https://cdn.referals.mx/leo.jpg"');
      expect(leo).toContain('<span class="handle-ig" title="Instagram">IG @leoglow</span>');
      expect(leo).toContain('<span class="handle-tt" title="TikTok">TT @leo.tt</span>');
      expect(leo).toMatch(/<span class="score num">\d{1,3}% Match<\/span>/);
      expect(leo).toContain('data-tag="niche_match"');
      expect(leo).toContain('data-tag="verified"');
      expect(leo).toContain('<span class="payout-amount num">$97.35 MXN</span>'); // 649 × 15%
      expect(leo).toContain('>Invitar a Campaña</button>');
      expect(leo).toContain('<textarea id="note-LEO" name="custom_note" maxlength="500"');
      expect(html).toContain('.score{flex:none;display:inline-flex;align-items:center;min-height:32px;padding:0 12px;border-radius:9999px;background:var(--cyan);\n  color:var(--onyx)');

      // Non-https avatar → initials badge; no insecure URL on the page.
      expect(html).toContain('<div class="avatar" aria-hidden="true">MR</div>');
      expect(html).not.toContain('http://insecure.example');
      // Sellers never see creator contact or banking data.
      expect(html).not.toContain('+525512345678');
      expect(html).not.toContain('002010077777777771');
    });

    it('falls back to initials for products without a photo and escapes seller-controlled text', async () => {
      await createCampaign(alice, { name: '<script>alert(1)</script> Bálsamo' });
      const html = (await dashboard(await signIn())).body;
      expect(html).toContain('<div class="thumb" aria-hidden="true">&lt;B</div>');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Bálsamo');
      expect(html).not.toContain('<script>alert(1)');
    });

    it('shows an empty state when the seller has no campaigns', async () => {
      const html = (await dashboard(await signIn(bob))).body;
      expect(html).toContain('Aún no tienes campañas.');
      expect(html).toContain('Lanza una campaña activa para ver a los creadores');
      expect(html).not.toContain('id="quota-badge"');
      expect(html).toContain('Primero registra un producto activo');
    });
  });

  // ---------------------------------------------------------------------------
  describe('KPI aggregation & tenant isolation', () => {
    it('sums attributed paid sales, active creators and redeemed coupons for this seller only', async () => {
      await seedCreator(db, { slug: 'ANA', name: 'Ana', email: 'ana@creators.mx', niche: 'beauty' });
      await attributedSale(alice, campaignId, 'LEO', 'A-1', 1020);
      await attributedSale(alice, campaignId, 'ANA', 'A-2', 499.5);

      // Bob's business must not leak into Alice's numbers.
      const bobCampaign = (await createCampaign(bob, { name: 'Bob Earbuds', category: 'electronics' })).campaignId;
      await attributedSale(bob, bobCampaign, 'MIA', 'B-1', 9999);

      const html = (await dashboard(await signIn())).body;
      expect(html).toContain('id="kpi-gmv">$1,519.50 MXN</span>');
      expect(html).toContain('id="kpi-creators">2</span>');
      expect(html).toContain('id="kpi-coupons">2</span>');
      expect(html).not.toContain('Bob Earbuds');

      const bobHtml = (await dashboard(await signIn(bob))).body;
      expect(bobHtml).toContain('id="kpi-gmv">$9,999.00 MXN</span>');
      expect(bobHtml).toContain('id="kpi-creators">1</span>');
      expect(bobHtml).not.toContain('Glow Serum');
    });

    it('excludes refunded sales from GMV', async () => {
      await attributedSale(alice, campaignId, 'LEO', 'A-1', 1000);
      const raw = JSON.stringify({ event: 'order.refunded', seller_order_id: 'A-1', timestamp: clock.now().toISOString() });
      const refund = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/orders/refunded',
        headers: { 'content-type': 'application/json', 'x-referals-seller-id': alice.seller.id, 'x-referals-signature': signPayload(raw, alice.webhookSecret) },
        payload: raw,
      });
      expect(refund.statusCode, refund.body).toBeLessThan(300);
      expect((await dashboard(await signIn())).body).toContain('id="kpi-gmv">$0.00 MXN</span>');
    });

    it("answers another seller's campaign with a 404 that reveals nothing", async () => {
      const bobCampaign = (await createCampaign(bob, { name: 'Bob Earbuds', category: 'electronics' })).campaignId;
      const cookie = await signIn();
      const res = await dashboard(cookie, `?campaign=${bobCampaign}`);
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('Campaña no encontrada.');
      expect(res.body).not.toContain('Bob Earbuds');
      expect(res.body).not.toContain('id="quota-badge"');

      const csrf = csrfOf((await dashboard(cookie)).body);
      const invite = await inviteJson(cookie, { campaign_id: bobCampaign, creator_slug: 'LEO', csrf });
      expect(invite.statusCode).toBe(404);
      expect(invite.json().error.code).toBe('CAMPAIGN_NOT_FOUND');
      expect(await db.select().from(campaignInvitations)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('invitations from the matchmaker', () => {
    it('invites inline (JSON): 201 with the decremented quota, then the card shows "Invitado (Expira en 7d)"', async () => {
      const cookie = await signIn();
      const csrf = csrfOf((await dashboard(cookie)).body);
      const res = await inviteJson(cookie, { campaign_id: campaignId, creator_slug: 'LEO', custom_note: '¡Nos encanta tu contenido!', csrf });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({
        status: 'pending',
        creator: { slug: 'LEO' },
        custom_note: '¡Nos encanta tu contenido!',
        quota: { active_pending: 1, max_pending: 25, can_invite: true },
      });
      await vi.waitFor(() => expect(outbox.messages).toHaveLength(1));
      expect(outbox.messages[0]!.template).toBe('campaign_invitation');

      const html = (await dashboard(cookie)).body;
      expect(html).toContain('<p class="state state-pending num" role="status">Invitado (Expira en 7d)</p>');
      expect(html).toContain('data-slots="badge">24 / 25 Slots Activos</span>');
      expect(html).toContain('id="kpi-slots" data-slots="kpi">24 / 25</span>');

      // Same rules as the API: a second invite is a 409.
      const again = await inviteJson(cookie, { campaign_id: campaignId, creator_slug: 'LEO', csrf });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('INVITATION_PENDING');
    });

    it('works without JavaScript: the form post redirects back with a success notice', async () => {
      const cookie = await signIn();
      const csrf = csrfOf((await dashboard(cookie)).body);
      const res = await app.inject({
        method: 'POST',
        url: '/seller/dashboard/invite',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ campaign_id: campaignId, creator_slug: 'LEO', custom_note: '', csrf }).toString(),
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe(`/seller/dashboard?campaign=${campaignId}&status=invited`);
      const html = (await dashboard(cookie, `?campaign=${campaignId}&status=invited`)).body;
      expect(html).toContain('Invitación enviada por WhatsApp. Vence en 7 días.');
      expect(html).toContain('Invitado (Expira en 7d)');

      const [row] = await db.select().from(campaignInvitations);
      expect(row!.customNote).toBeNull();
    });

    it('requires a session and the dashboard CSRF token', async () => {
      const cookie = await signIn();
      const csrf = csrfOf((await dashboard(cookie)).body);
      const noSession = await app.inject({ method: 'POST', url: '/seller/dashboard/invite', payload: { campaign_id: campaignId, creator_slug: 'LEO', csrf } });
      expect(noSession.statusCode).toBe(401);
      expect(noSession.json().error.code).toBe('SESSION_EXPIRED');

      const badCsrf = await inviteJson(cookie, { campaign_id: campaignId, creator_slug: 'LEO', csrf: 'x'.repeat(43) });
      expect(badCsrf.statusCode).toBe(403);
      expect(badCsrf.json().error.code).toBe('CSRF_TOKEN_INVALID');

      // Another seller's CSRF token doesn't match this session.
      const bobCookie = await signIn(bob);
      const crossCsrf = await inviteJson(cookie, { campaign_id: campaignId, creator_slug: 'LEO', csrf: csrfOf((await dashboard(bobCookie)).body) });
      expect(crossCsrf.statusCode).toBe(403);
      expect(await db.select().from(campaignInvitations)).toHaveLength(0);
    });

    it('disables every "Invitar" button with a tooltip once 25 invitations are pending', async () => {
      // 25 low-affinity creators already invited; LEO (top match) is still invitable.
      const now = clock.now();
      for (let i = 0; i < 25; i++) {
        const c = await seedCreator(db, { slug: `ZZ${String(i).padStart(2, '0')}`, email: `zz${i}@creators.mx`, niche: 'electronics', followersCount: 300 });
        await db.insert(campaignInvitations).values({
          campaignId,
          sellerId: alice.seller.id,
          creatorId: c.id,
          matchScore: 10,
          matchReason: 'seeded',
          expiresAt: new Date(now.getTime() + 7 * DAY),
          sentAt: now,
        });
      }
      const cookie = await signIn();
      const html = (await dashboard(cookie)).body;
      expect(html).toContain('data-slots="badge">0 / 25 Slots Activos</span>');
      expect(html).toContain('class="quota-badge num full"');

      const leo = matchCard(html, 'LEO');
      expect(leo).toContain(
        '<span title="Límite de 25 invitaciones pendientes alcanzado"><button class="btn btn-cyan" type="submit" disabled title="Límite de 25 invitaciones pendientes alcanzado">Invitar a Campaña</button></span>',
      );
      expect(leo).toContain('<p class="limit-hint">Límite de 25 invitaciones pendientes alcanzado</p>');
      expect(html).not.toMatch(/<button class="btn btn-cyan" type="submit">/);

      // The server enforces it regardless of the UI.
      const res = await inviteJson(cookie, { campaign_id: campaignId, creator_slug: 'LEO', csrf: csrfOf(html) });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('INVITATION_PENDING_LIMIT_REACHED');
    });

    it('shows joined, declined and expired (re-sendable) states', async () => {
      await seedCreator(db, { slug: 'ANA', name: 'Ana', email: 'ana@creators.mx', niche: 'beauty' });
      await seedCreator(db, { slug: 'EVA', name: 'Eva', email: 'eva@creators.mx', niche: 'beauty' });
      await api(alice, 'POST', `/v1/campaigns/${campaignId}/links`, { creator_slug: 'LEO' });
      for (const slug of ['ANA', 'EVA']) await api(alice, 'POST', `/v1/campaigns/${campaignId}/invitations`, { creator_slug: slug });
      const [ana] = await db.select().from(campaignInvitations);
      await db.update(campaignInvitations).set({ status: 'declined' }).where(eq(campaignInvitations.id, ana!.id));
      clock.advance(8 * DAY); // EVA's invitation lapses → re-sendable

      const html = (await dashboard(await signIn())).body;
      const card = (slug: string) => matchCard(html, slug);
      expect(card('LEO')).toContain('✓ Ya promociona esta campaña');
      expect(card('ANA')).toContain('Declinó esta campaña');
      expect(card('EVA')).toContain('>Reenviar invitación</button>');
    });
  });

  // ---------------------------------------------------------------------------
  describe('launch a campaign', () => {
    it('creates a campaign from the drawer form and opens its matchmaker', async () => {
      const second = await api(alice, 'POST', '/v1/products', {
        name: 'Night Cream',
        price: 400,
        margin: 150,
        checkout_base_url: 'https://glowshop.mx/checkout',
        category: 'beauty',
      });
      const cookie = await signIn();
      const html = (await dashboard(cookie)).body;
      expect(html).toContain(`<option value="${second.json().id}">Night Cream</option>`);

      const res = await app.inject({
        method: 'POST',
        url: '/seller/dashboard/campaigns',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ csrf: csrfOf(html), product_id: second.json().id, commission_percent: '12.5', is_public_catalog: 'true' }).toString(),
      });
      expect(res.statusCode).toBe(303);
      const location = res.headers.location as string;
      const newId = /campaign=([0-9a-f-]{36})&status=campaign_created$/.exec(location)![1]!;
      const [row] = await db.select().from(campaigns).where(eq(campaigns.id, newId));
      expect(row).toMatchObject({ productId: second.json().id, commissionRate: '0.1250', isPublicCatalog: true, status: 'active' });

      const page = (await dashboard(cookie, location.slice('/seller/dashboard'.length))).body;
      expect(page).toContain('¡Campaña lanzada!');
      expect(page).toContain('Creadores recomendados para Night Cream');
      expect(page).toContain('<span class="payout-amount num">$50.00 MXN</span>'); // 400 × 12.5%
    });

    it("rejects invalid input and another seller's product", async () => {
      const bobProduct = (await createCampaign(bob, { name: 'Bob Earbuds', category: 'electronics' })).productId;
      const cookie = await signIn();
      const csrf = csrfOf((await dashboard(cookie)).body);
      const post = (fields: Record<string, string>) =>
        app.inject({
          method: 'POST',
          url: '/seller/dashboard/campaigns',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams({ csrf, ...fields }).toString(),
        });

      expect((await post({ product_id: productId, commission_percent: '0' })).headers.location).toBe('/seller/dashboard?status=INVALID_CAMPAIGN');
      expect((await post({ product_id: productId, commission_percent: '150' })).headers.location).toBe('/seller/dashboard?status=INVALID_CAMPAIGN');
      expect((await post({ product_id: bobProduct, commission_percent: '10' })).headers.location).toBe('/seller/dashboard?status=PRODUCT_NOT_FOUND');
      expect((await post({ product_id: productId, commission_percent: '10', csrf: 'nope' })).headers.location).toBe('/seller/dashboard?status=INVALID_FORM');
      expect(await db.select().from(campaigns).where(eq(campaigns.productId, bobProduct))).toHaveLength(1);
    });
  });
});
