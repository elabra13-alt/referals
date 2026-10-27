import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { creators, ledgerEntries, withdrawalRequests } from '../../src/db/schema.js';
import { creatorStorefrontItems } from '../../src/db/schema/storefront.js';
import { MagicSessions } from '../../src/modules/creators/magic-link.js';
import { InMemoryWhatsAppOutbox } from '../../src/modules/notifications/whatsapp.service.js';
import { signPayload } from '../../src/modules/webhooks/signature.js';
import { TEST_ENCRYPTION_KEY, TestClock, createTestDb, createTestRedis, seedAuthenticatedSeller, seedCreator } from '../helpers.js';

type Seller = Awaited<ReturnType<typeof seedAuthenticatedSeller>>;
type Creator = Awaited<ReturnType<typeof seedCreator>>;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BANAMEX = '002010077777777771';
const PHOTO = 'https://cdn.glowshop.mx/serum.jpg';

describe('creator mobile portal (/c/wallet, /c/storefront, /c/invitations)', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let outbox: InMemoryWhatsAppOutbox;
  let alice: Seller;
  let leo: Creator;
  let productId: string;
  let campaignId: string;

  const optedIn = (slug: string, overrides: Partial<Parameters<typeof seedCreator>[1]> = {}) =>
    seedCreator(db, { slug, name: `Creator ${slug}`, phone: '+525512345678', whatsappOptInAt: new Date('2026-10-01T00:00:00.000Z'), ...overrides });

  const asSeller = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, headers: alice.authHeaders, ...(payload ? { payload } : {}) });

  const cookieNamed = (res: LightMyRequestResponse, name: string) => {
    const header = res.headers['set-cookie'];
    const line = (Array.isArray(header) ? header : [header ?? '']).find((l) => l.startsWith(`${name}=`));
    expect(line, name).toBeDefined();
    return line!.split(';')[0]!;
  };

  /** Invites the creator and opens the WhatsApp magic link: returns the invitation id and both session cookies. */
  const openMagicLink = async (creator = leo, campaign = campaignId) => {
    const before = outbox.messages.length;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaign}/invitations`,
      headers: alice.authHeaders,
      payload: { creator_slug: creator.slug },
    });
    expect(res.statusCode, res.body).toBe(201);
    await vi.waitFor(() => expect(outbox.messages.length).toBe(before + 1));
    const url = new URL(outbox.messages[before]!.parameters[4]!);
    const opened = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(opened.statusCode).toBe(303);
    return {
      invitationId: res.json().id as string,
      magicUrl: `${url.pathname}${url.search}`,
      invitationCookie: cookieNamed(opened, 'ref_inv'),
      portal: cookieNamed(opened, 'ref_creator'),
    };
  };

  /** Re-tapping the WhatsApp link (valid for the invitation's 7 days) opens a fresh 24h portal session. */
  const reopen = async (magicUrl: string) => cookieNamed(await get(magicUrl), 'ref_creator');

  const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  const csrfOf = (html: string) => {
    const match = /name="csrf" value="([^"]+)"/.exec(html);
    expect(match, 'csrf field').not.toBeNull();
    return match![1]!;
  };

  const postForm = (url: string, cookie: string, fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });

  /** Posts a form from the page at `pageUrl`, carrying its CSRF (and any extra hidden fields). */
  const submit = async (pageUrl: string, action: string, cookie: string, fields: Record<string, string> = {}) => {
    const html = (await get(pageUrl, cookie)).body;
    return postForm(action, cookie, { csrf: csrfOf(html), ...fields });
  };

  const accept = async (session: { invitationId: string; invitationCookie: string }) => {
    const html = (await get(`/c/invitations/${session.invitationId}`, session.invitationCookie)).body;
    const csrf = /"csrf":"([^"]+)"/.exec(html)![1]!;
    const res = await app.inject({
      method: 'POST',
      url: `/c/invitations/${session.invitationId}/respond`,
      headers: { cookie: session.invitationCookie },
      payload: { action: 'accept', csrf },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { link_url: string; storefront_url: string };
  };

  /** Credits matured commission straight into the ledger (what the escrow worker does). */
  const credit = (creator: Creator, amount: string) =>
    db.insert(ledgerEntries).values({ influencerSlug: creator.slug, entryType: 'escrow_release', amount, description: 'test credit' });

  const registerClabe = (cookie: string, fields: Record<string, string> = {}) =>
    submit('/c/wallet', '/c/wallet/payout-profile', cookie, { clabe: '002 010 07777777777 1', legal_name: 'Leonardo Méndez Ruiz', rfc: '', ...fields });

  const withdrawFromPage = async (cookie: string) => {
    const html = (await get('/c/wallet', cookie)).body;
    const key = /name="idempotency_key" value="([^"]+)"/.exec(html)![1]!;
    return { key, res: await postForm('/c/wallet/withdraw', cookie, { csrf: csrfOf(html), idempotency_key: key }) };
  };

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-26T18:00:00.000Z'));
    outbox = new InMemoryWhatsAppOutbox();
    app = buildApp(
      {
        db,
        redis: await createTestRedis(),
        webhookEncryptionKey: TEST_ENCRYPTION_KEY,
        whatsappProvider: outbox,
        now: clock.now,
        generatorOptions: { now: clock.now },
      },
      { logger: false },
    );
    alice = await seedAuthenticatedSeller(db, 'Alice Beauty');
    leo = await optedIn('LEO', { speiClabe: null });
    const product = await asSeller('POST', '/v1/products', {
      name: 'Glow Serum',
      price: 649,
      margin: 200,
      checkout_base_url: 'https://shop.example.mx/checkout',
      category: 'beauty',
      image_url: PHOTO,
    });
    expect(product.statusCode, product.body).toBe(201);
    productId = product.json().id;
    campaignId = (await asSeller('POST', '/v1/campaigns', { product_id: productId, commission_rate: 0.15 })).json().id;
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  // ---------------------------------------------------------------------------
  describe('portal session', () => {
    it('is opened by the magic link and gates every portal page', async () => {
      const { portal } = await openMagicLink();
      for (const url of ['/c/wallet', '/c/storefront', '/c/invitations']) {
        const signedOut = await get(url);
        expect(signedOut.statusCode, url).toBe(401);
        expect(signedOut.body).toContain('Abre tu portal desde WhatsApp');
        const page = await get(url, portal);
        expect(page.statusCode, url).toBe(200);
        expect(page.headers['cache-control']).toBe('no-store');
        expect(page.headers['content-security-policy']).toContain("form-action 'self'");
      }
    });

    it('rejects forged, expired and revoked sessions', async () => {
      const { portal } = await openMagicLink();
      const forged = new MagicSessions(Buffer.alloc(32, 9)).issuePortal({ id: leo.id, apiKeyHash: leo.apiKeyHash }, clock.now());
      expect((await get('/c/wallet', `ref_creator=${forged.value}`)).statusCode).toBe(401);
      const [, value] = portal.split('=') as [string, string];
      const other = await optedIn('MIA');
      expect((await get('/c/wallet', `ref_creator=${value.replace(leo.id, other.id)}`)).statusCode).toBe(401);

      // Rotating the API key signs every browser out.
      await db.update(creators).set({ apiKeyHash: 'rotated' }).where(eq(creators.id, leo.id));
      expect((await get('/c/wallet', portal)).statusCode).toBe(401);
    });

    it('expires after 24h and closes for suspended creators', async () => {
      const { portal } = await openMagicLink();
      clock.advance(DAY - 1000);
      expect((await get('/c/wallet', portal)).statusCode).toBe(200);
      await db.update(creators).set({ status: 'suspended' }).where(eq(creators.id, leo.id));
      expect((await get('/c/wallet', portal)).statusCode).toBe(401);
      await db.update(creators).set({ status: 'active' }).where(eq(creators.id, leo.id));
      clock.advance(1000);
      expect((await get('/c/wallet', portal)).statusCode).toBe(401);
    });

    it('also opens the creator’s own invitation pages, but not anyone else’s', async () => {
      const { invitationId, portal } = await openMagicLink();
      expect((await get(`/c/invitations/${invitationId}`, portal)).statusCode).toBe(200);
      const mia = await openMagicLink(await optedIn('MIA'));
      expect((await get(`/c/invitations/${mia.invitationId}`, portal)).statusCode).toBe(401);
    });

    it('shows the bottom tab bar with the current tab marked', async () => {
      const { portal } = await openMagicLink();
      const html = (await get('/c/wallet', portal)).body;
      expect(html).toContain('<nav class="tabbar" aria-label="Portal de creador">');
      expect(html).toContain('<a class="tab" href="/c/wallet" aria-current="page">');
      expect(html).toContain('href="/c/storefront"');
      expect(html).toContain('href="/c/invitations"');
      expect(html).toContain('Mi Vitrina');
      expect(html).toContain('Mi Billetera');
      expect(html).toContain('Invitaciones');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Mi Billetera', () => {
    it('shows available and escrow balances with tabular numerals', async () => {
      const session = await openMagicLink();
      const { link_url } = await accept(session);
      await credit(leo, '250.00');
      // A real sale on the new link: 15% of $1,020 = $153.00 into escrow.
      const linkSlug = link_url.split('/').pop()!;
      const code = (
        await app.inject({ method: 'POST', url: '/v1/codes/request', payload: { link_slug: linkSlug, buyer: { email: 'v@gmail.com' } }, remoteAddress: '10.80.0.1' })
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
        headers: { 'content-type': 'application/json', 'x-referals-seller-id': alice.seller.id, 'x-referals-signature': signPayload(raw, alice.webhookSecret) },
        payload: raw,
      });
      expect(paid.statusCode, paid.body).toBeLessThan(300);

      const html = (await get('/c/wallet', session.portal)).body;
      expect(html).toContain('<p class="balance-amount num" id="available">$250.00 MXN</p>');
      expect(html).toContain('<p class="balance-amount num" id="escrow">$153.00 MXN</p>');
      expect(html).toContain('class="balance balance-available"');
      expect(html).toContain('class="balance balance-escrow"');
      expect(html).toContain('--mint:#10B981');
      expect(html).toContain('--amber:#F59E0B');
      expect(html).toMatch(/\.num\{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on\}/);
      expect(html).toContain('queda en custodia de 14 a 28 días');
      expect(html).not.toMatch(/gradient/i);
    });

    it('registers a first CLABE from the inline form (Modulo-10 checked) and holds withdrawals 24h', async () => {
      const { portal } = await openMagicLink();
      const before = (await get('/c/wallet', portal)).body;
      expect(before).toContain('Registra tu cuenta CLABE');
      expect(before).toContain('<button class="btn btn-money" type="submit" disabled>Retirar fondos disponibles</button>');

      const bad = await registerClabe(portal, { clabe: '002010077777777772' });
      expect(bad.statusCode).toBe(303);
      expect(bad.headers.location).toBe('/c/wallet?status=INVALID_CLABE');
      expect((await db.select().from(creators).where(eq(creators.id, leo.id)))[0]!.speiClabe).toBeNull();
      expect((await get(bad.headers.location as string, portal)).body).toContain('la CLABE debe tener 18 dígitos válidos');

      const ok = await registerClabe(portal);
      expect(ok.headers.location).toBe('/c/wallet?status=profile_saved');
      const [row] = await db.select().from(creators).where(eq(creators.id, leo.id));
      expect(row).toMatchObject({ speiClabe: BANAMEX, payoutLegalName: 'Leonardo Méndez Ruiz', speiClabeChangedAt: clock.now() });

      const html = (await get('/c/wallet?status=profile_saved', portal)).body;
      expect(html).toContain('¡Cuenta guardada!');
      expect(html).toContain('<span>Banamex</span>');
      expect(html).toContain('<span class="num">•••• 7771</span>');
      expect(html).toContain('Leonardo Méndez Ruiz');
      expect(html).not.toContain(BANAMEX);
      expect(html).not.toContain('Registra tu cuenta CLABE');
      expect(html).toContain('podrás retirar a partir del');

      // The portal never replaces an account.
      expect((await registerClabe(portal, { clabe: '646180000118359719' })).headers.location).toBe('/c/wallet?status=PROFILE_LOCKED');
      expect((await db.select().from(creators).where(eq(creators.id, leo.id)))[0]!.speiClabe).toBe(BANAMEX);
    });

    it('withdraws the full available balance from the form after the hold, exactly once per page', async () => {
      const session = await openMagicLink();
      await registerClabe(session.portal);
      await credit(leo, '250.00');

      const held = await withdrawFromPage(session.portal);
      expect(held.res.headers.location).toBe('/c/wallet?status=PAYOUT_ACCOUNT_COOLING_OFF');
      expect(await db.select().from(withdrawalRequests)).toHaveLength(0);

      clock.advance(DAY);
      const portal = await reopen(session.magicUrl);
      const { key, res } = await withdrawFromPage(portal);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/c/wallet?status=withdrawal_requested');
      const rows = await db.select().from(withdrawalRequests);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ creatorId: leo.id, amount: '250.00', status: 'pending', clabe: BANAMEX });

      // A double tap re-posts the same page's idempotency key: still one withdrawal.
      const html = (await get('/c/wallet', portal)).body;
      await postForm('/c/wallet/withdraw', portal, { csrf: csrfOf(html), idempotency_key: key });
      expect(await db.select().from(withdrawalRequests)).toHaveLength(1);

      const after = (await get('/c/wallet?status=withdrawal_requested', portal)).body;
      expect(after).toContain('Retiro solicitado');
      expect(after).toContain('<p class="balance-amount num" id="available">$0.00 MXN</p>');
      const ref = `WDR-${rows[0]!.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      expect(after).toContain(`<span class="ref num">${ref}</span>`);
      expect(after).toContain('<span class="amount num">$250.00 MXN</span>');
      expect(after).toContain('<span class="pill pill-amber">Pendiente</span>');

      await db.update(withdrawalRequests).set({ status: 'paid', processedAt: clock.now() }).where(eq(withdrawalRequests.id, rows[0]!.id));
      expect((await get('/c/wallet', portal)).body).toContain('<span class="pill pill-mint">Completado</span>');
    });

    it('enforces the $100.00 minimum server-side', async () => {
      const session = await openMagicLink();
      await registerClabe(session.portal);
      clock.advance(DAY);
      const portal = await reopen(session.magicUrl);
      await credit(leo, '50.00');
      const page = (await get('/c/wallet', portal)).body;
      expect(page).toContain('El retiro mínimo es de $100.00 MXN.');
      expect((await withdrawFromPage(portal)).res.headers.location).toBe('/c/wallet?status=BELOW_MINIMUM_WITHDRAWAL');
      expect(await db.select().from(withdrawalRequests)).toHaveLength(0);
    });

    it('rejects posts without the session’s CSRF token or without a session', async () => {
      const session = await openMagicLink();
      await registerClabe(session.portal);
      clock.advance(DAY);
      const portal = await reopen(session.magicUrl);
      await credit(leo, '250.00');
      const forged = await postForm('/c/wallet/withdraw', portal, { csrf: 'x'.repeat(43), idempotency_key: 'wdr_attacker_1234' });
      expect(forged.headers.location).toBe('/c/wallet?status=INVALID_FORM');
      expect((await postForm('/c/wallet/withdraw', '', { csrf: 'x', idempotency_key: 'wdr_attacker_1234' })).statusCode).toBe(401);
      expect(await db.select().from(withdrawalRequests)).toHaveLength(0);
    });

    it('only renders known outcome messages (nothing reflected from the URL)', async () => {
      const { portal } = await openMagicLink();
      const html = (await get('/c/wallet?status=%3Cscript%3Ealert(1)%3C/script%3E', portal)).body;
      expect(html).not.toContain('alert(1)');
      expect(html).not.toContain('class="flash');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Mi Vitrina', () => {
    it('shows the bio link, product cards with photo, commission and the 3 hooks', async () => {
      const session = await openMagicLink();
      await accept(session);
      const html = (await get('/c/storefront', session.portal)).body;

      expect(html).toContain('<a class="vanity-link" id="vanity-link" href="https://referals.mx/@leo">referals.mx/@leo</a>');
      expect(html).toContain('data-copy="vanity"');
      expect(html).toContain('>Copiar Enlace de Biografía</button>');
      expect(html).toContain('"vanity":"https://referals.mx/@leo"');
      expect(html).toContain(`<img class="thumb" src="${PHOTO}" alt="Glow Serum"`);
      expect(html).toContain('<h3>Glow Serum</h3>');
      expect(html).toContain('<span class="pill pill-cyan num">15% comisión</span>');
      expect(html).toContain('<span class="pill pill-mint">Visible</span>');
      expect(html).toContain('<summary>Ver mis 3 hooks de video</summary>');
      for (const angle of ['Problema', 'Prueba', 'Oferta']) expect(html).toContain(`>${angle}</span>`);
      expect(html).toContain('>Copiar guion</button>');
      expect(html).toContain('>Ocultar de mi vitrina</button>');
    });

    it('hides and re-shows a product on the public storefront', async () => {
      const session = await openMagicLink();
      await accept(session);
      const [item] = await db.select().from(creatorStorefrontItems).where(eq(creatorStorefrontItems.creatorId, leo.id));
      const action = `/c/storefront/items/${item!.id}/visibility`;
      expect((await get('/@leo')).body).toContain('<h3>Glow Serum</h3>');

      const hide = await submit('/c/storefront', action, session.portal, { is_active: 'false' });
      expect(hide.headers.location).toBe('/c/storefront?status=item_hidden');
      expect((await db.select().from(creatorStorefrontItems))[0]!.isActive).toBe(false);
      expect((await get('/@leo')).body).not.toContain('<h3>Glow Serum</h3>');
      const page = (await get('/c/storefront', session.portal)).body;
      expect(page).toContain('<span class="pill pill-neutral">Oculto</span>');
      expect(page).toContain('>Mostrar en mi vitrina</button>');

      const show = await submit('/c/storefront', action, session.portal, { is_active: 'true' });
      expect(show.headers.location).toBe('/c/storefront?status=item_shown');
      expect((await get('/@leo')).body).toContain('<h3>Glow Serum</h3>');
    });

    it('cannot toggle another creator’s item', async () => {
      const mia = await optedIn('MIA');
      const miaSession = await openMagicLink(mia);
      await accept(miaSession);
      const [miaItem] = await db.select().from(creatorStorefrontItems).where(eq(creatorStorefrontItems.creatorId, mia.id));

      const { portal } = await openMagicLink();
      // Leo's own storefront is empty; the CSRF token is per session, so any portal page carries it.
      const res = await submit('/c/wallet', `/c/storefront/items/${miaItem!.id}/visibility`, portal, { is_active: 'false' });
      expect(res.headers.location).toBe('/c/storefront?status=NOT_FOUND');
      expect((await db.select().from(creatorStorefrontItems).where(eq(creatorStorefrontItems.id, miaItem!.id)))[0]!.isActive).toBe(true);
    });

    it('points new creators to their invitations when the storefront is empty', async () => {
      const { portal } = await openMagicLink();
      expect((await get('/c/storefront', portal)).body).toContain('Aún no tienes productos');
    });
  });

  // ---------------------------------------------------------------------------
  describe('Invitaciones', () => {
    it('lists the creator’s invitations, newest actionable first', async () => {
      const { invitationId, portal } = await openMagicLink();
      const html = (await get('/c/invitations', portal)).body;
      expect(html).toContain('<h3>Glow Serum</h3>');
      expect(html).toContain('<span class="pill pill-coral">Nueva</span>');
      expect(html).toContain('$97.35 MXN por venta');
      expect(html).toContain(`href="/c/invitations/${invitationId}">Ver invitación</a>`);
      expect(html).toContain('<a class="tab" href="/c/invitations" aria-current="page">');
    });
  });

  // ---------------------------------------------------------------------------
  describe('product images', () => {
    it('renders the photo on the invitation page and public storefront', async () => {
      const session = await openMagicLink();
      const invitation = await get(`/c/invitations/${session.invitationId}`, session.invitationCookie);
      expect(invitation.body).toContain(`<img class="tile" src="${PHOTO}" alt="Glow Serum"`);
      expect(invitation.headers['content-security-policy']).toContain("img-src 'self' data: https:");
      await accept(session);
      expect((await get('/@leo')).body).toContain(`<img class="product-photo" src="${PHOTO}" alt="Glow Serum"`);
    });

    it('falls back to the initials badge when the product has no photo', async () => {
      const cleared = await asSeller('PATCH', `/v1/products/${productId}`, { image_url: null });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().image_url).toBeNull();

      const session = await openMagicLink();
      const invitation = (await get(`/c/invitations/${session.invitationId}`, session.invitationCookie)).body;
      expect(invitation).toContain('<div class="tile" aria-hidden="true">GS</div>');
      expect(invitation).not.toContain('<img class="tile"');
      await accept(session);
      expect((await get('/@leo')).body).toContain('<div class="product-photo" aria-hidden="true">GS</div>');
      expect((await get('/c/storefront', session.portal)).body).toContain('<div class="thumb" aria-hidden="true">GS</div>');
    });

    it('accepts only https image URLs from sellers and escapes them', async () => {
      const http = await asSeller('PATCH', `/v1/products/${productId}`, { image_url: 'http://cdn.glowshop.mx/serum.jpg' });
      expect(http.statusCode).toBe(400);
      const js = await asSeller('PATCH', `/v1/products/${productId}`, { image_url: 'javascript:alert(1)' });
      expect(js.statusCode).toBe(400);
      expect((await asSeller('GET', `/v1/products/${productId}`)).json().image_url).toBe(PHOTO);

      const tricky = 'https://cdn.glowshop.mx/a.jpg?x="><script>alert(1)</script>';
      expect((await asSeller('PATCH', `/v1/products/${productId}`, { image_url: tricky })).statusCode).toBe(200);
      const session = await openMagicLink();
      const html = (await get(`/c/invitations/${session.invitationId}`, session.invitationCookie)).body;
      expect(html).not.toContain('<script>alert(1)');
    });
  });
});
