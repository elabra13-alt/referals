import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { DEMO_LINK_SLUG } from '../../../src/modules/links/links.routes.js';
import {
  ESCROW_CATEGORY_OPTIONS,
  ROI_ASSUMPTIONS,
  computeRoi,
  formatMxn,
  renderMarketingHomePage,
} from '../../../src/modules/links/marketing-template.js';
import {
  TEST_ENCRYPTION_KEY,
  createTestDb,
  createTestRedis,
  expectOfficialLogo,
  expectSvgFavicon,
  expectUniqueIds,
} from '../../helpers.js';

// ---------- Minimal DOM for executing the page's real inline script ----------

class FakeElement {
  value = '';
  textContent = '';
  focused = false;
  private attrs = new Map<string, string>();
  private listeners: Record<string, ((e: unknown) => void)[]> = {};

  constructor(attrs: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string, event: Record<string, unknown> = {}) {
    let prevented = false;
    for (const fn of this.listeners[type] ?? []) fn({ ...event, preventDefault: () => (prevented = true) });
    return prevented;
  }
  focus() {
    this.focused = true;
  }
}

function bootHomePage(html: string, hash = '') {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const config = /<script type="application\/json" id="mk-config">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const el: Record<string, FakeElement> = {
    'mk-config': Object.assign(new FakeElement(), { textContent: config }),
    'tab-marcas': new FakeElement({ 'aria-selected': 'true' }),
    'tab-creadores': new FakeElement({ 'aria-selected': 'false' }),
    'panel-marcas': new FakeElement(),
    'panel-creadores': new FakeElement({ hidden: '' }),
    'calc-slider': Object.assign(new FakeElement(), { value: String(ROI_ASSUMPTIONS.defaultGross) }),
    'calc-category': Object.assign(new FakeElement(), { value: 'beauty' }),
  };
  for (const id of ['calc-gross', 'out-net', 'out-commission', 'out-savings', 'out-escrow']) el[id] = new FakeElement();

  const windowListeners: Record<string, (() => void)[]> = {};
  const location = { hash };
  runInNewContext(script, {
    JSON,
    Math,
    Number,
    String,
    Intl,
    location,
    document: { getElementById: (id: string) => el[id] ?? null },
    window: { addEventListener: (t: string, fn: () => void) => void (windowListeners[t] ??= []).push(fn) },
  });

  const navigate = (newHash: string) => {
    location.hash = newHash;
    for (const fn of windowListeners.hashchange ?? []) fn();
  };
  const selectedTab = () => (el['tab-marcas']!.getAttribute('aria-selected') === 'true' ? 'marcas' : 'creadores');
  return { el, navigate, selectedTab };
}

// ---------- Tests ----------

describe('marketing homepage', () => {
  let app: FastifyInstance;
  let closeDb: () => Promise<void>;
  let home: LightMyRequestResponse;

  beforeAll(async () => {
    const { db, close } = await createTestDb();
    closeDb = close;
    app = buildApp({ db, redis: await createTestRedis(), webhookEncryptionKey: TEST_ENCRYPTION_KEY }, { logger: false });
    home = await app.inject({ method: 'GET', url: '/' });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  describe('GET / and GET /home', () => {
    it('serves the homepage as HTML', () => {
      expect(home.statusCode).toBe(200);
      expect(home.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(home.body.startsWith('<!doctype html>')).toBe(true);
      expect(home.body).toContain('<html lang="es-MX">');
    });

    it('sends the strict landing-page security headers with a nonce matching the inline script and style', () => {
      const csp = home.headers['content-security-policy'] as string;
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(csp).toContain(`style-src 'nonce-${nonce}'`);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(home.body).toContain(`<script nonce="${nonce}">`);
      expect(home.body).toContain(`<style nonce="${nonce}">`);
      expect(home.body.match(/<script nonce=/g)).toHaveLength(1); // single executable script block
      expect(home.headers['x-content-type-options']).toBe('nosniff');
      expect(home.headers['x-frame-options']).toBe('DENY');
      expect(home.headers['cache-control']).toBe('no-store');
    });

    it('issues a fresh nonce per request', async () => {
      const again = await app.inject({ method: 'GET', url: '/' });
      expect(again.headers['content-security-policy']).not.toBe(home.headers['content-security-policy']);
    });

    it('serves /home as an alias with identical status, headers and structure', async () => {
      const alias = await app.inject({ method: 'GET', url: '/home' });
      expect(alias.statusCode).toBe(200);
      expect(alias.headers['content-type']).toBe(home.headers['content-type']);
      expect(alias.headers['x-frame-options']).toBe('DENY');
      const withoutNonce = (html: string) => html.replace(/nonce="[^"]+"/g, 'nonce="N"');
      expect(withoutNonce(alias.body)).toBe(withoutNonce(home.body));
    });

    it('leaves the buyer landing routes untouched', async () => {
      const res = await app.inject({ method: 'GET', url: '/r/does-not-exist' });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('Enlace no encontrado');
    });
  });

  describe('content', () => {
    it('contains the brand, Shopify positioning and the spec copy', () => {
      const html = home.body;
      expect(html).toContain('Referrals');
      expect(html).toContain('Shopify');
      expect(html).toContain('⚡ LATAM E-Commerce');
      expect(html).toContain('🇲🇽 La primera red de atribución determinística para Shopify México');
      expect(html.replace(/<\/?em>/g, '')).toContain(
        'Convierte microinfluencers en tu canal #1 de ventas en Shopify. Sin costos fijos.',
      );
      expect(html).toContain('Cupones dinámicos de un solo uso que Honey no puede robar');
      for (const link of ['Solución para Marcas', 'Creadores', 'Tecnología', 'Calculadora', 'Ver Demo en Vivo']) {
        expect(html).toContain(link);
      }
      expect(html).toContain(
        '© 2026 Referrals Inc. Infraestructura de atribución determinística para e-commerce en México y LATAM.',
      );
    });

    it('uses the official brand name "Referrals" in title, meta, nav, visual and footer', () => {
      const html = home.body;
      expect(html).toContain('<title>Referrals · Microinfluencers que venden en tu Shopify, sin costos fijos</title>');
      expect(html).toContain('<meta property="og:title" content="Referrals · Microinfluencers que venden en tu Shopify">');
      expect(html).toContain('aria-label="Referrals, inicio"');
      expect(html).toContain('aria-label="El puente: tu tienda Shopify, Referrals y el creador"');
      expect(html).toContain('<div><strong>Referrals</strong><small>Atribución determinística + Escrow</small></div>');
      expect(html).toContain('© 2026 Referrals Inc.');
      // The single-r spelling must not render anywhere (case-insensitive).
      expect(html).not.toMatch(/Referals/i);
      // Example coupon in the hero still follows REF-[CREATOR]-[ENTROPY].
      expect(html).toContain('<code class="num">REF-VALER-7K2M</code>');
    });

    it('links the demo CTAs to the live buyer demo', () => {
      expect(home.body).toContain(`href="/r/${DEMO_LINK_SLUG}">Ver Demo en Vivo</a>`);
      expect(home.body).toContain(`id="cta-demo" href="/r/${DEMO_LINK_SLUG}">Probar Demo de Comprador</a>`);
    });

    it('renders the Bridge tabs with accessible tab semantics', () => {
      const html = home.body;
      expect(html).toContain('role="tablist"');
      expect(html).toMatch(/<button class="tab" role="tab" id="tab-marcas" aria-selected="true" aria-controls="panel-marcas"/);
      expect(html).toMatch(/id="panel-creadores" aria-labelledby="tab-creadores" hidden>/);
      for (const feature of ['0 Costo Fijo', 'Escrow Anti-Devoluciones', 'Cupones Anti-Fuga', 'Conexión en 3 clics', 'Guion Viral de TikTok / Reels', 'Pagos automáticos por SPEI']) {
        expect(html).toContain(feature);
      }
    });

    it('renders the calculator markup with server-computed defaults (works without JS)', () => {
      const html = home.body;
      expect(html).toContain(`<input type="range" id="calc-slider" name="gross" min="10000" max="500000" step="5000" value="100000">`);
      expect(html).toMatch(/<select id="calc-category" name="category">/);
      expect(html).toContain('id="calc-gross" aria-live="polite">$100,000</div>');
      expect(html).toContain('<span id="out-net">$90,000</span>');
      expect(html).toContain('<span id="out-commission">$13,500</span>');
      expect(html).toContain('<span id="out-savings">$1,200</span>');
      expect(html).toContain('<span id="out-escrow">14</span>');
      expect(html).toContain('Venta Neta Generada');
      expect(html).toContain('Comisión para Creadores (15%)');
      expect(html).toContain('Ahorro estimado en cupones no canibalizados');
      expect(html).toContain('Días de garantía Escrow');
      expect(html).toContain('no una garantía de resultados');
    });

    it('lists the four how-it-works steps in order', () => {
      const steps = [...home.body.matchAll(/<li class="card step"><h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
      expect(steps).toEqual([
        'Conecta tu Shopify en 3 minutos.',
        'La IA analiza tu catálogo y redacta los guiones virales.',
        'Los creadores comparten su link exclusivo.',
        'Cada comprador recibe un cupón único y el dinero se liquida por SPEI tras el escrow.',
      ]);
    });

    it('uses the flat "Kinetic Commercial Nexus" palette', () => {
      const html = home.body;
      for (const token of [
        // Surfaces, wells, borders, text, dark anchor
        '#FFFFFF', '#F8FAFC', '#F1F5F9', '#E2E8F0', '#0F141C', '#0B0F17', '#1E293B', '#334155', '#64748B',
        // Solid accents: TikTok Coral (+hover/active), Instagram Berry, Cyan, Mint, Amber
        '#FE2C55', '#E02449', '#C81E3F', '#D62976', '#00B4D8', '#10B981', '#F59E0B',
      ]) {
        expect(html).toContain(token);
      }
      expect(html).toContain('<meta name="theme-color" content="#FFFFFF">');
      expect(html).toContain("'Plus Jakarta Sans',Inter,system-ui");
    });

    it('is 100% flat: no gradients, shadows, blurs or filters anywhere in the page', () => {
      const html = home.body;
      for (const banned of ['gradient', 'box-shadow', 'text-shadow', 'backdrop-filter', 'blur(', 'drop-shadow', 'filter:']) {
        expect(html).not.toContain(banned);
      }
      for (const legacy of ['#7C3AED', '#EC4899', '#6D28D9', '#DB2777', '#FDF4FF', '#020617']) expect(html).not.toContain(legacy);
    });

    it('styles components per the design system: solid CTAs, border-based states, tinted metrics', () => {
      const html = home.body;
      // Primary CTA: solid Coral with hover/active fills; secondary inverts to Onyx.
      expect(html).toContain('.btn-primary{background:var(--coral);color:#FFFFFF}');
      expect(html).toContain('.btn-primary:hover{background:var(--coral-hover)}');
      expect(html).toContain('.btn-primary:active{background:var(--coral-active)}');
      expect(html).toContain('.btn-ghost:hover{background:var(--onyx);color:#FFFFFF}');
      // White labels on Coral are large text (>= 18.66px bold); targets >= 48px.
      expect(html).toContain('font-size:19px;font-weight:800');
      expect(html).toContain('min-height:52px');
      // Solid nav canopy with hairline border (no frosted blur).
      expect(html).toContain('.nav{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--line)}');
      expect(html).toMatch(/<a class="brand" href="\/" aria-label="Referrals, inicio">\s*<svg class="brand-logo"/);
      // Hero badge in solid Berry; headline highlight is a solid Coral underline, not gradient text.
      expect(html).toContain('background:var(--berry);\n  color:#FFFFFF');
      expect(html).toContain('text-decoration-color:var(--coral)');
      // Tabs: recessed well track; active = white card with Onyx edge + accent bar per audience.
      expect(html).toContain('.tab[aria-selected="true"]{background:var(--surface);color:var(--onyx);border-color:var(--onyx)}');
      expect(html).toContain('#tab-marcas[aria-selected="true"]{border-bottom-color:var(--mint)}');
      expect(html).toContain('#tab-creadores[aria-selected="true"]{border-bottom-color:var(--berry)}');
      // Native slider in solid Coral.
      expect(html).toContain('input[type=range]{width:100%;height:48px;accent-color:var(--coral)');
      // Metrics: well, dark revenue anchor (Mint figure), Cyan "estimado" tag, Amber "escrow" tag.
      expect(html).toContain('<div class="card metric well"><dt>Venta Neta Generada');
      expect(html).toContain('<div class="card metric anchor"><dt>Comisión para Creadores');
      expect(html).toContain('.metric.anchor dd{color:var(--mint)}');
      expect(html).toContain('<span class="tag tag-cyan">Estimado</span>');
      expect(html).toContain('<span class="tag tag-amber">Escrow</span>');
      expect(html).toContain('.tag-amber{background:var(--amber);color:var(--onyx)}');
      expect(html).toContain('.tag-cyan{background:var(--cyan);color:var(--onyx)}');
    });

    it('keeps tabular numerals on every metric and amount', () => {
      const html = home.body;
      expect(html).toContain('.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on}');
      // Live values sit inside tabular-numeral containers.
      expect(html).toContain('<div class="calc-gross num" id="calc-gross"');
      for (const id of ['out-net', 'out-commission', 'out-savings', 'out-escrow']) {
        expect(html).toContain(`<dd class="num"><span id="${id}">`);
      }
      expect(html).toContain('<div class="range-scale num">');
      expect(html).toContain('<code class="num">REF-VALER-7K2M</code>');
    });

    it('is CSP-clean and lightweight: no external resources, no inline style attributes', () => {
      const html = home.body;
      expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=["']https?:/);
      expect(html).not.toMatch(/ style="/);
      expect(html).not.toMatch(/ on[a-z]+="/); // no inline event handlers
      expect(Buffer.byteLength(html)).toBeLessThan(40_000);
    });
  });

  describe('brand logo', () => {
    it('shows the official inline SVG mark in the nav, before the wordmark', () => {
      const html = home.body;
      expect(html).toContain(
        '<svg class="brand-logo" viewBox="0 0 40 40" width="32" height="32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
      );
      expect(html).toMatch(/<\/svg>Referrals/);
      expectOfficialLogo(html);
    });

    it('repeats the mark in the footer and in the Bridge visual', () => {
      expect(home.body).toContain('<span class="footer-brand"><svg class="brand-logo" viewBox="0 0 40 40" width="20" height="20"');
      expect(home.body).toContain('<svg class="brand-logo icon" viewBox="0 0 40 40" width="40" height="40"');
      expect(home.body.match(/<svg class="brand-logo/g)).toHaveLength(3);
    });

    it('never duplicates element ids', () => {
      expectUniqueIds(home.body);
    });

    it('uses the same mark as a self-contained SVG favicon', () => {
      expectSvgFavicon(home.body);
    });

    it('stays image-free: no <img> tags or external image URLs', () => {
      expect(home.body).not.toMatch(/<img\b/);
      expect(home.body).not.toMatch(/(href|src)="https?:\/\/[^"]+\.(png|jpe?g|webp|gif|svg)"/);
    });
  });

  describe('client script (executed)', () => {
    it('switches tabs on click and with arrow keys', () => {
      const page = bootHomePage(home.body);
      expect(page.selectedTab()).toBe('marcas');

      page.el['tab-creadores']!.fire('click');
      expect(page.selectedTab()).toBe('creadores');
      expect(page.el['panel-creadores']!.hasAttribute('hidden')).toBe(false);
      expect(page.el['panel-marcas']!.hasAttribute('hidden')).toBe(true);
      expect(page.el['tab-marcas']!.getAttribute('tabindex')).toBe('-1');

      const prevented = page.el['tab-creadores']!.fire('keydown', { key: 'ArrowRight' });
      expect(prevented).toBe(true);
      expect(page.selectedTab()).toBe('marcas');
      expect(page.el['tab-marcas']!.focused).toBe(true);
    });

    it('opens the right tab from the nav deep links (#creadores / #marcas)', () => {
      expect(bootHomePage(home.body, '#creadores').selectedTab()).toBe('creadores');
      const page = bootHomePage(home.body);
      page.navigate('#creadores');
      expect(page.selectedTab()).toBe('creadores');
      page.navigate('#marcas');
      expect(page.selectedTab()).toBe('marcas');
    });

    it.each([10_000, 37_500, 250_000, 500_000])('updates every metric live, matching the server math, at %i MXN', (gross) => {
      const page = bootHomePage(home.body);
      page.el['calc-slider']!.value = String(gross);
      page.el['calc-slider']!.fire('input');

      const r = computeRoi(gross);
      expect(page.el['calc-gross']!.textContent).toBe(formatMxn(r.gross));
      expect(page.el['out-net']!.textContent).toBe(formatMxn(r.net));
      expect(page.el['out-commission']!.textContent).toBe(formatMxn(r.commission));
      expect(page.el['out-savings']!.textContent).toBe(formatMxn(r.leakageSavings));
      expect(page.el['calc-slider']!.getAttribute('aria-valuetext')).toBe(`${formatMxn(r.gross)} MXN al mes`);    });

    it('shows escrow days for the chosen category', () => {
      const page = bootHomePage(home.body);
      expect(page.el['out-escrow']!.textContent).toBe('14');
      for (const [category, days] of [['fashion', '28'], ['electronics', '25'], ['home', '21']] as const) {
        page.el['calc-category']!.value = category;
        page.el['calc-category']!.fire('change');
        expect(page.el['out-escrow']!.textContent).toBe(days);
      }
    });
  });

  describe('calculator model', () => {
    it('computes net, commission and leakage savings in whole pesos', () => {
      expect(computeRoi(100_000)).toEqual({ gross: 100_000, net: 90_000, commission: 13_500, leakageSavings: 1_200 });
      expect(computeRoi(500_000)).toEqual({ gross: 500_000, net: 450_000, commission: 67_500, leakageSavings: 6_000 });
    });

    it('clamps to the slider range', () => {
      expect(computeRoi(1).gross).toBe(10_000);
      expect(computeRoi(9_999_999).gross).toBe(500_000);
    });

    it('takes escrow days from the real escrow engine', () => {
      expect(Object.fromEntries(ESCROW_CATEGORY_OPTIONS.map((c) => [c.value, c.days]))).toEqual({
        beauty: 14,
        home: 21,
        electronics: 25,
        fashion: 28,
      });
    });
  });

  describe('renderMarketingHomePage', () => {
    it('falls back to the how-it-works anchor without a demo link', () => {
      const html = renderMarketingHomePage({ nonce: 'abc' });
      expect(html).toContain('id="cta-demo" href="#como-funciona"');
      expect(html).toContain('id="como-funciona"');
    });

    it('URL-encodes the demo slug', () => {
      const html = renderMarketingHomePage({ nonce: 'abc', demoLinkSlug: 'a b"<x>' });
      expect(html).toContain('href="/r/a%20b%22%3Cx%3E"');
      expect(html).not.toContain('<x>');
    });
  });
});
