import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';
import { campaigns, links, products } from '../src/db/schema.js';
import { escapeHtml, formatPrice, safeJsonForHtml } from '../src/modules/links/landing-template.js';
import {
  TEST_ENCRYPTION_KEY,
  TestClock,
  createTestDb,
  createTestRedis,
  expectOfficialLogo,
  expectSvgFavicon,
  expectUniqueIds,
  seedCreator,
  seedLink,
} from './helpers.js';

// ---------- Minimal DOM harness for running the page's real inline script ----------

class FakeElement {
  value = '';
  textContent = '';
  disabled = false;
  checked = false;
  style: Record<string, string> = {};
  private attrs: Record<string, string> = {};
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  private classes: Set<string>;
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };

  constructor(classes: string[] = []) {
    this.classes = new Set(classes);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {} });
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  focus() {}
  select() {}
}

/** Boots the landing page HTML in a sandbox whose fetch goes through `app.inject`. */
/** Simulated clipboard environment: async API outcome, secure context, legacy execCommand outcome. */
interface ClipboardEnv {
  asyncClipboard?: 'ok' | 'reject' | 'missing';
  secureContext?: boolean;
  execCommand?: 'ok' | 'false' | 'throw';
}

function bootPage(html: string, app: FastifyInstance, ip: string, env: ClipboardEnv = {}) {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const config = /<script type="application\/json" id="ref-config">([\s\S]*?)<\/script>/.exec(html)![1]!;

  const ids = ['ref-form', 'ref-submit', 'ref-error', 'ref-phone', 'ref-wa', 'ref-email', 'ref-code', 'ref-go', 'ref-copy', 'ref-timer', 'ref-request'];
  const el: Record<string, FakeElement> = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  el['ref-result'] = new FakeElement(['hidden']);
  el['ref-config'] = Object.assign(new FakeElement(), { textContent: config });

  const clipboard: string[] = [];
  /** Text copied via the legacy textarea + execCommand path. */
  const legacyCopies: string[] = [];
  /** Nodes highlighted for manual copy (last-resort path). */
  const selections: unknown[] = [];
  const navigations: string[] = [];
  const requests: { url: string; body: unknown }[] = [];
  const intervals: unknown[] = [];

  let lastTextarea: FakeElement | null = null;
  const asyncClipboard = env.asyncClipboard ?? 'ok';
  const execMode = env.execCommand ?? 'ok';

  runInNewContext(script, {
    JSON,
    Date,
    Math,
    Promise,
    setTimeout,
    setInterval: (fn: () => void) => (intervals.push(fn), 1),
    clearInterval: () => undefined,
    document: {
      getElementById: (id: string) => el[id] ?? null,
      createElement: () => (lastTextarea = new FakeElement()),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => {
        if (execMode === 'throw') throw new Error('execCommand not supported');
        if (execMode === 'false') return false;
        legacyCopies.push(lastTextarea?.value ?? '');
        return true;
      },
      createRange: () => ({ selectNodeContents: (node: unknown) => void selections.push(node) }),
    },
    navigator: {
      userAgent: 'vitest',
      ...(asyncClipboard === 'missing'
        ? {}
        : {
            clipboard: {
              writeText: async (t: string) => {
                if (asyncClipboard === 'reject') throw new DOMException('Document is not focused.', 'NotAllowedError');
                clipboard.push(t);
              },
            },
          }),
    },
    window: {
      isSecureContext: env.secureContext ?? true,
      location: { assign: (u: string) => void navigations.push(u) },
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    },
    fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      requests.push({ url, body: JSON.parse(init.body) });
      const res = await app.inject({ method: init.method as 'POST', url, headers: init.headers, payload: init.body, remoteAddress: ip });
      return { status: res.statusCode, json: async () => res.json() };
    },
  });

  return { el, clipboard, legacyCopies, selections, navigations, requests };
}

// ---------- Tests ----------

describe('landing page helpers', () => {
  it('escapes HTML and script-breaking JSON', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
    const json = safeJsonForHtml({ name: '</script><script>alert(1)</script>' });
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json)).toEqual({ name: '</script><script>alert(1)</script>' });
  });

  it('formats MXN prices', () => {
    expect(formatPrice('1499.5', 'MXN')).toBe('$1,499.50 MXN');
  });
});

describe('buyer landing & link resolution', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let clock: TestClock;
  let ipSeq = 0;
  const nextIp = () => `10.20.0.${++ipSeq}`;

  /** A creator-backed link, as Sprint 5 issues them. */
  const seedCreatorLink = async (overrides: { productName?: string } = {}) => {
    const creator = await seedCreator(db, { slug: 'LEO', name: 'Leo Mendez', handle: '@soyleomx' });
    const { link, product } = await seedLink(db, { influencerSlug: 'LEO', linkSlug: 'leo-glow-8k2m' });
    await db.update(links).set({ creatorId: creator.id }).where(eq(links.id, link.id));
    if (overrides.productName) await db.update(products).set({ name: overrides.productName }).where(eq(products.id, product.id));
    return { link, product };
  };

  beforeEach(async () => {
    ({ db, close: closeDb } = await createTestDb());
    clock = new TestClock(Date.parse('2026-10-13T16:00:00.000Z'));
    app = buildApp(
      { db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY, now: clock.now, generatorOptions: { now: clock.now } },
      { logger: false },
    );
  });

  afterEach(async () => {
    await app.close();
    await closeDb();
  });

  describe('GET /v1/links/:link_slug/preview', () => {
    it('returns the public preview contract', async () => {
      await seedCreatorLink();
      const res = await app.inject({ method: 'GET', url: '/v1/links/leo-glow-8K2M/preview' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        link_slug: 'leo-glow-8k2m',
        creator: { name: 'Leo Mendez', handle: '@soyleomx' },
        product: { name: 'Glow Serum', price: '499.00', currency: 'MXN', category: 'beauty' },
        status: 'active',
      });
      expect(res.headers['cache-control']).toBe('public, max-age=30');
    });

    it('falls back to the influencer slug for legacy links without a creator profile', async () => {
      await seedLink(db, { influencerSlug: 'leo', linkSlug: 'legacy-link' });
      const res = await app.inject({ method: 'GET', url: '/v1/links/legacy-link/preview' });
      expect(res.json().creator).toEqual({ name: 'leo', handle: null });
    });

    it('never exposes seller, checkout or payout internals', async () => {
      await seedCreatorLink();
      const body = (await app.inject({ method: 'GET', url: '/v1/links/leo-glow-8k2m/preview' })).body;
      for (const secret of ['seller', 'checkout', 'margin', 'shop.example.mx', 'email', 'clabe', 'platform_fee', 'commission', '0.1500']) {
        expect(body.toLowerCase()).not.toContain(secret);
      }
    });

    it.each([
      ['unknown', 'nope-nope'],
      ['malformed', '-bad!slug'],
    ])('returns 404 for an %s slug', async (_label, slug) => {
      const res = await app.inject({ method: 'GET', url: `/v1/links/${encodeURIComponent(slug)}/preview` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('LINK_NOT_FOUND');
    });

    it.each([
      ['paused link', { linkStatus: 'paused' }, 'link_paused'],
      ['expired link', { linkExpiresAt: new Date('2026-10-01T00:00:00Z') }, 'link_expired'],
      ['archived product', { productStatus: 'archived' as const }, 'product_inactive'],
    ])('returns 410 for a %s', async (_label, opts, status) => {
      await seedLink(db, { linkSlug: 'dead-link', ...opts });
      const res = await app.inject({ method: 'GET', url: '/v1/links/dead-link/preview' });
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toMatchObject({ code: 'LINK_INACTIVE', details: { status } });
    });

    it('returns 410 campaign_inactive for a paused campaign', async () => {
      const { campaign } = await seedLink(db, { linkSlug: 'paused-campaign' });
      await db.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, campaign.id));
      const res = await app.inject({ method: 'GET', url: '/v1/links/paused-campaign/preview' });
      expect(res.json().error.details.status).toBe('campaign_inactive');
    });
  });

  describe('GET /l/:link_slug and /r/:link_slug', () => {
    it('serves a self-contained, mobile-first page with product and creator', async () => {
      await seedCreatorLink();
      const res = await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      const html = res.body;
      expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">');
      expect(html).toContain('<html lang="es-MX">');
      expect(html).toContain('Glow Serum');
      expect(html).toContain('@soyleomx');
      expect(html).toContain('$499.00 MXN');
      // No third-party resources: one request to first paint.
      // Only self-contained data: URIs (the favicon) may be referenced.
      expect(html).not.toMatch(/<(link|script|img)[^>]+(href|src)="(?!data:)/);
      expect(Buffer.byteLength(html)).toBeLessThan(25_000);
    });

    it('applies the flat "Kinetic Commercial Nexus" palette and tabular numerals to prices, codes and timers', async () => {
      await seedCreatorLink();
      const html = (await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' })).body;
      for (const token of [
        // Surfaces, borders, text
        '#FFFFFF', '#F8FAFC', '#E2E8F0', '#0F141C', '#334155', '#64748B',
        // Solid accents: TikTok Coral (+hover/active), Instagram Berry, Cyan, Mint, Amber
        '#FE2C55', '#E02449', '#C81E3F', '#D62976', '#00B4D8', '#10B981', '#F59E0B',
      ]) {
        expect(html).toContain(token);
      }
      expect(html).toContain('<meta name="theme-color" content="#FFFFFF">');
      expect(html).toContain('.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on}');
      expect(html).toMatch(/class="price num"/);
      expect(html).toMatch(/class="code num" id="ref-code"/);
      expect(html).toMatch(/class="timer num" id="ref-timer"/);
    });

    it('is 100% flat: no gradients, shadows, blurs or filters anywhere in the page', async () => {
      await seedCreatorLink();
      const html = (await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' })).body;
      for (const banned of ['gradient', 'box-shadow', 'text-shadow', 'backdrop-filter', 'blur(', 'drop-shadow', 'filter:']) {
        expect(html).not.toContain(banned);
      }
      // Legacy "Electric Creator" palette is gone.
      for (const legacy of ['#7C3AED', '#EC4899', '#6D28D9', '#DB2777', '#0F172A']) expect(html).not.toContain(legacy);
    });

    it('styles components per the design system (solid fills, borders for depth, 48px targets)', async () => {
      await seedCreatorLink();
      const html = (await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' })).body;
      // Primary CTA: solid Coral, white label at large-text size, hover/active fills.
      expect(html).toContain('min-height:52px');
      expect(html).toContain('font-size:19px;font-weight:800;cursor:pointer;width:100%;background:var(--coral);color:#FFFFFF');
      expect(html).toContain('.btn:hover{background:var(--coral-hover)}');
      expect(html).toContain('.btn:active{background:var(--coral-active)}');
      // Inputs: 48px, 1px border, focus switches to solid Coral (no glow ring).
      expect(html).toContain('input[type=email],input[type=tel]{width:100%;height:48px;');
      expect(html).toContain('input[type=email]:focus,input[type=tel]:focus{outline:1px solid var(--coral);outline-offset:0;border-color:var(--coral)}');
      // Cards: white, 1px #E2E8F0, 12px radius.
      expect(html).toContain('.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;');
      // Creator attribution in solid Berry; status pill in Mint with Onyx text (white on Mint fails contrast).
      expect(html).toContain('.avatar{width:44px;height:44px;border-radius:50%;background:var(--berry);color:#FFFFFF;');
      expect(html).toContain('<span class="pill pill-berry">Recomendado</span>');
      expect(html).toContain('.pill-mint{background:var(--mint);color:var(--onyx)}');
      // Revealed code: high-impact surface with a 2px Onyx edge; secondary Copy inverts on hover.
      expect(html).toContain('border:2px solid var(--onyx);border-radius:12px;');
      expect(html).toContain('.copy:hover,.copy:active{background:var(--onyx);color:#FFFFFF}');
      // Expiry countdown: solid Amber pill with Onyx text.
      expect(html).toContain('background:var(--amber);\n  color:var(--onyx)');
      // Narrow phones never break the code mid-string.
      expect(html).toContain('white-space:nowrap}');
      expect(html).toContain('@media (max-width:430px){');
    });

    it('keeps the zero-friction reveal: code, 1-click copy, auto-apply store link and WhatsApp fallback', async () => {
      await seedCreatorLink();
      const html = (await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' })).body;
      expect(html).toContain('<h2>¡Cupón activado!</h2>');
      expect(html).toContain('<button class="copy" id="ref-copy" type="button">Copiar</button>');
      expect(html).toContain('id="ref-go"');
      expect(html).toContain('<input id="ref-wa" type="checkbox" disabled> Envíame un respaldo por WhatsApp');
    });

    it('sends a nonce-based CSP that matches the inline script and style', async () => {
      await seedCreatorLink();
      const res = await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' });
      const csp = res.headers['content-security-policy'] as string;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.body).toContain(`<script nonce="${nonce}">`);
      expect(res.body).toContain(`<style nonce="${nonce}">`);
      expect(res.body).not.toMatch(/ style="/); // inline style attributes would be blocked by the CSP
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');

      const second = await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' });
      expect(second.headers['content-security-policy']).not.toBe(csp); // fresh nonce per request
    });

    it('serves /r as an alias of /l (the shareable PUBLIC_LINK_BASE_URL path)', async () => {
      await seedCreatorLink();
      const res = await app.inject({ method: 'GET', url: '/r/LEO-GLOW-8K2M' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Glow Serum');
    });

    it('escapes seller-controlled content (stored XSS)', async () => {
      await seedCreatorLink({ productName: '</script><script>alert(1)</script><b>' });
      const html = (await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' })).body;
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<b>');
      expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;b&gt;');
    });

    it('brands the page with the inline Referrals logo (footer + favicon) and keeps the creator avatar up top', async () => {
      await seedCreatorLink();
      const html = (await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' })).body;
      expect(html).toContain('<div class="avatar" aria-hidden="true">LM</div>');
      expect(html).toContain('<footer><span class="powered"><svg class="brand-logo" viewBox="0 0 40 40" width="16" height="16"');
      expectOfficialLogo(html);
      expectUniqueIds(html);
      expectSvgFavicon(html);
    });

    it('uses the official brand name "Referrals" everywhere it renders (never the single-r spelling)', async () => {
      await seedCreatorLink();
      const live = (await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' })).body;
      expect(live).toContain('Código de un solo uso · Powered by Referrals</span></footer>');
      const missing = (await app.inject({ method: 'GET', url: '/l/does-not-exist' })).body;
      expect(missing).toContain('<div><strong>Referrals</strong></div></header>');
      await seedLink(db, { linkSlug: 'old-promo', linkExpiresAt: new Date('2026-10-01T00:00:00Z') });
      const gone = (await app.inject({ method: 'GET', url: '/l/old-promo' })).body;
      for (const html of [live, missing, gone]) expect(html).not.toMatch(/Referals/i);
    });

    it('keeps the AGENTS.md coupon syntax REF-[CREATOR]-[ENTROPY] after the rename', async () => {
      await seedCreatorLink();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/codes/request',
        payload: { link_slug: 'leo-glow-8k2m', buyer: { email: 'valeria@gmail.com' } },
        remoteAddress: '10.20.9.9',
      });
      expect(res.json().code).toMatch(/^REF-[A-Z0-9]{3,5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    });

    it('shows the Referrals logo on the unavailable pages', async () => {
      const html = (await app.inject({ method: 'GET', url: '/l/does-not-exist' })).body;
      expect(html).toContain('<header class="top"><svg class="brand-logo" viewBox="0 0 40 40" width="40" height="40"');
      expect(html).not.toContain('<div class="avatar" aria-hidden="true">R</div>');
      expectOfficialLogo(html);
      expectUniqueIds(html);
      for (const banned of ['gradient', 'box-shadow', 'blur(']) expect(html).not.toContain(banned);
    });

    it('renders a 404 page for unknown links and a 410 page for inactive ones', async () => {
      const missing = await app.inject({ method: 'GET', url: '/l/does-not-exist' });
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(missing.body).toContain('Enlace no encontrado');

      await seedLink(db, { linkSlug: 'old-promo', linkExpiresAt: new Date('2026-10-01T00:00:00Z') });
      const gone = await app.inject({ method: 'GET', url: '/l/old-promo' });
      expect(gone.statusCode).toBe(410);
      expect(gone.body).toContain('Promoción terminada');
      expect(gone.body).not.toContain('ref-form');
    });
  });

  describe('client script (executed against the real API)', () => {
    const loadPage = async () => (await app.inject({ method: 'GET', url: '/l/leo-glow-8k2m' })).body;

    it('issues a code on submit, then copies it and redirects to the auto-apply URL', async () => {
      await seedCreatorLink();
      const page = bootPage(await loadPage(), app, nextIp());

      page.el['ref-email']!.value = 'valeria@gmail.com';
      page.el['ref-form']!.fire('submit');

      await vi.waitFor(() => expect(page.el['ref-code']!.textContent).toMatch(/^REF-LEO-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/));
      const code = page.el['ref-code']!.textContent;
      expect(page.requests[0]).toMatchObject({
        url: '/v1/codes/request',
        body: { link_slug: 'leo-glow-8k2m', buyer: { email: 'valeria@gmail.com', phone: null, send_whatsapp_backup: false } },
      });
      expect(page.el['ref-result']!.classList.contains('hidden')).toBe(false);
      expect(page.el['ref-request']!.classList.contains('hidden')).toBe(true);
      expect(page.el['ref-timer']!.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);

      page.el['ref-copy']!.fire('click');
      await vi.waitFor(() => expect(page.clipboard).toEqual([code]));

      page.el['ref-go']!.fire('click');
      await vi.waitFor(() => expect(page.navigations).toHaveLength(1));
      expect(page.navigations[0]).toBe(
        `https://shop.example.mx/checkout?discount=${code}&utm_source=referals&utm_campaign=LEO`,
      );
      expect(page.clipboard).toEqual([code, code]); // copied again on the way to the store
    });

    describe('1-click copy works in every browser context', () => {
      /** Boots the page in `env`, requests a code and waits until it is revealed. */
      const revealIn = async (env: ClipboardEnv) => {
        await seedCreatorLink();
        const page = bootPage(await loadPage(), app, nextIp(), env);
        page.el['ref-email']!.value = 'valeria@gmail.com';
        page.el['ref-form']!.fire('submit');
        await vi.waitFor(() => expect(page.el['ref-code']!.textContent).toMatch(/^REF-LEO-/));
        return { page, code: page.el['ref-code']!.textContent };
      };

      it('falls back to the legacy copy when navigator.clipboard rejects, and still says "¡Copiado!"', async () => {
        const { page, code } = await revealIn({ asyncClipboard: 'reject' });
        page.el['ref-copy']!.fire('click');
        await vi.waitFor(() => expect(page.el['ref-copy']!.textContent).toBe('¡Copiado!'));
        expect(page.clipboard).toEqual([]);
        expect(page.legacyCopies).toEqual([code]);
      });

      it.each([
        ['insecure HTTP (e.g. a LAN IP on a phone)', { secureContext: false }],
        ['a browser without the async Clipboard API', { asyncClipboard: 'missing' as const }],
      ])('uses the legacy copy under %s and says "¡Copiado!"', async (_label, env) => {
        const { page, code } = await revealIn(env);
        page.el['ref-copy']!.fire('click');
        await vi.waitFor(() => expect(page.el['ref-copy']!.textContent).toBe('¡Copiado!'));
        expect(page.legacyCopies).toEqual([code]);
      });

      it.each([
        ['returns false', 'false' as const],
        ['throws', 'throw' as const],
      ])('never claims success when every copy method fails (execCommand %s): selects the code for manual copy', async (_label, execCommand) => {
        const { page } = await revealIn({ asyncClipboard: 'reject', execCommand });
        page.el['ref-copy']!.fire('click');
        await vi.waitFor(() => expect(page.el['ref-copy']!.textContent).toBe('Copia manual'));
        expect(page.selections).toEqual([page.el['ref-code']]);
      });

      it('resets the label to "Copiar" afterwards', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout'] });
        try {
          const { page } = await revealIn({ asyncClipboard: 'ok' });
          page.el['ref-copy']!.fire('click');
          await vi.waitFor(() => expect(page.el['ref-copy']!.textContent).toBe('¡Copiado!'));
          vi.advanceTimersByTime(1800);
          expect(page.el['ref-copy']!.textContent).toBe('Copiar');
        } finally {
          vi.useRealTimers();
        }
      });

      it('still redirects to the store when copying fails', async () => {
        const { page, code } = await revealIn({ asyncClipboard: 'reject', execCommand: 'false' });
        page.el['ref-go']!.fire('click');
        await vi.waitFor(() => expect(page.navigations).toHaveLength(1));
        expect(page.navigations[0]).toContain(`discount=${code}`);
      });
    });

    it('normalizes a 10-digit Mexican number and requests the WhatsApp backup', async () => {
      await seedCreatorLink();
      const page = bootPage(await loadPage(), app, nextIp());
      page.el['ref-phone']!.value = '55 1234 5678';
      page.el['ref-phone']!.fire('input');
      expect(page.el['ref-wa']!.disabled).toBe(false);
      page.el['ref-wa']!.checked = true;
      page.el['ref-form']!.fire('submit');

      await vi.waitFor(() => expect(page.el['ref-code']!.textContent).toMatch(/^REF-LEO-/));
      expect(page.requests[0]!.body).toMatchObject({ buyer: { phone: '+525512345678', send_whatsapp_backup: true } });
    });

    it('shows the existing code when the buyer already requested one (409)', async () => {
      await seedCreatorLink();
      const first = bootPage(await loadPage(), app, nextIp());
      first.el['ref-email']!.value = 'valeria@gmail.com';
      first.el['ref-form']!.fire('submit');
      await vi.waitFor(() => expect(first.el['ref-code']!.textContent).not.toBe(''));

      const second = bootPage(await loadPage(), app, nextIp());
      second.el['ref-email']!.value = 'valeria@gmail.com';
      second.el['ref-form']!.fire('submit');
      await vi.waitFor(() => expect(second.el['ref-code']!.textContent).toBe(first.el['ref-code']!.textContent));
    });

    it.each([
      ['a disposable email', 'temp@mailinator.com', 'Usa un correo permanente para recibir tu código.'],
      ['no contact at all', '', 'Escribe tu correo o tu WhatsApp.'],
    ])('shows a friendly error for %s', async (_label, email, message) => {
      await seedCreatorLink();
      const page = bootPage(await loadPage(), app, nextIp());
      page.el['ref-email']!.value = email;
      page.el['ref-form']!.fire('submit');
      await vi.waitFor(() => expect(page.el['ref-error']!.textContent).toBe(message));
      expect(page.el['ref-result']!.classList.contains('hidden')).toBe(true);
      expect(page.el['ref-submit']!.disabled).toBe(false);
    });

    it('surfaces the rate limit after 5 requests from one network', async () => {
      await seedCreatorLink();
      const ip = nextIp();
      for (let i = 0; i < 5; i++) {
        await app.inject({ method: 'POST', url: '/v1/codes/request', payload: { link_slug: 'leo-glow-8k2m', buyer: { email: `b${i}@gmail.com` } }, remoteAddress: ip });
      }
      const page = bootPage(await loadPage(), app, ip);
      page.el['ref-email']!.value = 'late@gmail.com';
      page.el['ref-form']!.fire('submit');
      await vi.waitFor(() => expect(page.el['ref-error']!.textContent).toBe('Demasiados intentos desde tu red. Intenta más tarde.'));
    });
  });

  it('code issuance accepts mixed-case link slugs from shared URLs', async () => {
    await seedCreatorLink();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/codes/request',
      payload: { link_slug: 'LEO-Glow-8K2M', buyer: { email: 'valeria@gmail.com' } },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(201);
  });
});
