import { escrowDaysForCategory } from '../webhooks/escrow.js';
import { brandFaviconHref, escapeHtml, renderBrandLogo, safeJsonForHtml } from './landing-template.js';

/**
 * Marketing homepage (GET /). Self-contained like the buyer landing page:
 * inline CSS/JS under the per-request CSP nonce, no external fonts, scripts
 * or images, no inline style attributes. Calculator assumptions live here once
 * and are handed to the client script as JSON, so the server-rendered numbers
 * (no-JS) and the live slider can never drift apart.
 */

// ---------- Calculator model ----------

export const ROI_ASSUMPTIONS = {
  minGross: 10_000,
  maxGross: 500_000,
  step: 5_000,
  defaultGross: 100_000,
  /** Creator commission on net collected sales. */
  commissionRate: 0.15,
  /** Buyer discount carried by each single-use code (Shopify default). */
  buyerDiscountRate: 0.1,
  /** Share of public-code orders that come from coupon extensions/aggregators. */
  leakedOrderShare: 0.12,
} as const;

export interface RoiResult {
  gross: number;
  net: number;
  commission: number;
  leakageSavings: number;
}

/** Whole pesos. Mirrored 1:1 by the client script (see `computeRoi` in SCRIPT). */
export function computeRoi(gross: number): RoiResult {
  const a = ROI_ASSUMPTIONS;
  const g = Math.min(a.maxGross, Math.max(a.minGross, Math.round(gross)));
  const net = Math.round(g * (1 - a.buyerDiscountRate));
  return {
    gross: g,
    net,
    commission: Math.round(net * a.commissionRate),
    // Discount margin that would leak to coupon-extension users on public codes.
    leakageSavings: Math.round(g * a.leakedOrderShare * a.buyerDiscountRate),
  };
}

/** Calculator categories, resolved through the real escrow engine. */
export const ESCROW_CATEGORY_OPTIONS = [
  { value: 'beauty', label: 'Belleza / Skincare / Consumibles' },
  { value: 'home', label: 'Hogar / Retail general' },
  { value: 'electronics', label: 'Electrónica / Audio' },
  { value: 'fashion', label: 'Moda / Calzado' },
].map((c) => ({ ...c, days: escrowDaysForCategory(c.value) }));

export function formatMxn(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: 0,
  }).format(amount);
}

// ---------- Styles: "Kinetic Commercial Nexus" (stitch_design/DESIGN.md) ----------
// 100% flat: no gradients, blurs or shadows. Depth = surface tiers (canvas #F8FAFC, white cards, #F1F5F9 wells,
// #0B0F17 dark anchor) + solid 1px/2px borders; hover/active swap border or fill colours.
// Contrast: Onyx text on Mint/Cyan/Amber; white on Coral only at large-text size; white on Berry >= 4.6:1.

const STYLES = `
:root{
  --canvas:#F8FAFC;--surface:#FFFFFF;--well:#F1F5F9;--line:#E2E8F0;
  --onyx:#0F141C;--night:#0B0F17;--night-line:#1E293B;--body:#334155;--muted:#64748B;
  --coral:#FE2C55;--coral-hover:#E02449;--coral-active:#C81E3F;
  --berry:#D62976;--cyan:#00B4D8;--mint:#10B981;--mint-600:#059669;--amber:#F59E0B;
  --font-display:'Plus Jakarta Sans',Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --font-body:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{font-family:var(--font-body);background:var(--canvas);color:var(--body);line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden}
h1,h2,h3,strong{font-family:var(--font-display);color:var(--onyx)}
a{color:inherit;text-decoration:none}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on}
.mono{font-family:var(--mono)}
.wrap{width:100%;max-width:1280px;margin:0 auto;padding:0 16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px}
:focus-visible{outline:3px solid var(--onyx);outline-offset:2px;border-radius:8px}

/* Nav: solid white canopy, hairline border (no blur) */
.nav{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--line)}
.nav .wrap{display:flex;align-items:center;gap:24px;height:68px}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--font-display);font-weight:800;font-size:19px;letter-spacing:-.02em;color:var(--onyx)}
.brand-tag{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:9999px;background:var(--mint);
  color:var(--onyx);font-family:var(--font-body);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.nav-links{display:flex;gap:4px;font-size:15px;font-weight:600;color:var(--body);margin-left:auto}
.nav-links a{display:inline-flex;align-items:center;min-height:48px;padding:0 12px;border-bottom:2px solid transparent}
.nav-links a:hover{color:var(--onyx);border-bottom-color:var(--coral)}

/* Buttons: min 48px targets. Primary = solid Coral; white label at large-text size (>= 18.66px bold) */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:12px 22px;border-radius:8px;
  font-family:var(--font-display);font-size:19px;font-weight:800;border:1px solid transparent;cursor:pointer;
  transition:background-color .12s,color .12s,border-color .12s}
.btn-primary{background:var(--coral);color:#FFFFFF}
.btn-primary:hover{background:var(--coral-hover)}
.btn-primary:active{background:var(--coral-active)}
.btn-ghost{background:var(--surface);color:var(--onyx);border-color:var(--onyx)}
.btn-ghost:hover{background:var(--onyx);color:#FFFFFF}
.btn-sm{min-height:48px;padding:10px 18px}

/* Hero */
.hero{padding-top:72px;padding-bottom:64px;display:grid;grid-template-columns:repeat(12,1fr);gap:24px;align-items:center}
.hero > div{grid-column:span 7}
.hero > figure{grid-column:span 5}
.badge{display:inline-flex;align-items:center;min-height:28px;padding:2px 12px;border-radius:9999px;background:var(--berry);
  color:#FFFFFF;font-size:13px;font-weight:700}
h1{font-size:clamp(36px,5vw,56px);line-height:1.05;letter-spacing:-.03em;margin:20px 0 18px;font-weight:800}
h1 em{font-style:normal;color:var(--onyx);text-decoration:underline;text-decoration-color:var(--coral);
  text-decoration-thickness:.14em;text-underline-offset:.12em}
.lead{font-size:18px;color:var(--body);max-width:600px}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.proof{display:flex;gap:12px;margin-top:32px;flex-wrap:wrap}
.proof > div{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 16px;font-size:13px;color:var(--muted)}
.proof strong{display:block;font-size:24px;letter-spacing:-.02em;line-height:1.2}

/* Bridge visual: white panel, wells for nodes, Tier-2 coupon ticket */
.bridge{padding:16px}
.node{display:flex;align-items:center;gap:12px;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--canvas)}
.icon{width:40px;height:40px;border-radius:8px;display:grid;place-items:center;flex:none;font-family:var(--font-display);font-weight:800;font-size:15px}
.i-shop{background:var(--mint);color:var(--onyx)}
.i-core{background:var(--onyx);color:#FFFFFF}
.i-creator{background:var(--berry);color:#FFFFFF}
.node small{display:block;color:var(--muted);font-size:12px}
.node .meta{margin-left:auto;text-align:right;font-size:12px;color:var(--muted)}
.wire{display:block;width:2px;height:30px;margin:0 0 0 31px}
.wire line{stroke:var(--coral);stroke-width:2;stroke-dasharray:4 6;animation:flow 1.2s linear infinite}
@keyframes flow{to{stroke-dashoffset:-20}}
.ticket{margin-top:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;
  border:2px solid var(--onyx);border-radius:12px;padding:12px 14px;background:var(--surface)}
.ticket code{font-family:var(--mono);font-size:18px;font-weight:800;letter-spacing:.04em;color:var(--onyx)}
.chip{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:9999px;background:var(--mint);
  color:var(--onyx);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}

/* Sections */
section{scroll-margin-top:84px}
.section{padding:64px 0;border-top:1px solid var(--line)}
.eyebrow{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:9999px;background:var(--onyx);color:#FFFFFF;
  font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
h2{font-size:clamp(26px,3.4vw,32px);letter-spacing:-.015em;line-height:1.2;margin:14px 0 12px;font-weight:700}
.section-lead{color:var(--body);max-width:640px;font-size:17px}

/* Bridge tabs: recessed well track; active tab = white card with solid Onyx edge + accent bar */
.tabs{display:inline-flex;gap:4px;padding:4px;border-radius:12px;background:var(--well);border:1px solid var(--line);margin:28px 0 20px}
.tab{appearance:none;border:1px solid transparent;border-bottom-width:3px;background:transparent;color:var(--body);font:inherit;
  font-family:var(--font-display);font-weight:700;font-size:16px;min-height:48px;padding:8px 18px;border-radius:8px;cursor:pointer}
.tab:hover{color:var(--onyx);border-color:var(--line)}
.tab[aria-selected="true"]{background:var(--surface);color:var(--onyx);border-color:var(--onyx)}
#tab-marcas[aria-selected="true"]{border-bottom-color:var(--mint)}
#tab-creadores[aria-selected="true"]{border-bottom-color:var(--berry)}
.panel{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.panel[hidden]{display:none}
.feature{padding:24px;transition:border-color .12s}
.feature:hover{border-color:var(--onyx)}
.feature h3{font-size:18px;letter-spacing:-.005em;margin-bottom:6px}
.feature p{color:var(--body);font-size:15px}
.feature .k{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:9999px;font-size:11px;font-weight:700;
  letter-spacing:.04em;margin-bottom:14px}
#panel-marcas .k{background:var(--mint);color:var(--onyx)}
#panel-creadores .k{background:var(--berry);color:#FFFFFF}

/* Calculator */
.calc{display:grid;grid-template-columns:5fr 7fr;gap:16px;margin-top:32px}
.calc-input{padding:24px}
.calc-input label{display:block;font-size:14px;font-weight:600;color:var(--onyx);margin-bottom:10px}
.calc-input label.mt{margin-top:24px;margin-bottom:0}
.calc-gross{font-family:var(--font-display);font-size:40px;font-weight:800;letter-spacing:-.02em;color:var(--onyx);margin-bottom:12px}
input[type=range]{width:100%;height:48px;accent-color:var(--coral);cursor:pointer;background:transparent}
.range-scale{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}
select{width:100%;min-height:48px;margin-top:6px;font:inherit;font-size:15px;color:var(--onyx);background:var(--surface);
  border:1px solid var(--line);border-radius:8px;padding:0 12px}
select:focus{outline:1px solid var(--coral);outline-offset:0;border-color:var(--coral)}
.assumptions{margin-top:18px;font-size:12px;color:var(--muted)}
.metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.metric{padding:20px}
.metric dt{font-size:13px;font-weight:600;color:var(--muted)}
.metric dd{font-family:var(--font-display);font-size:28px;line-height:32px;font-weight:800;letter-spacing:-.02em;color:var(--onyx);margin-top:8px}
.metric dd small{font-family:var(--font-body);font-size:14px;color:var(--muted);font-weight:600;letter-spacing:0;margin-left:4px}
.metric.well{background:var(--well)}
/* High-impact revenue: dark anchor card with Mint figure */
.metric.anchor{background:var(--night);border-color:var(--night-line)}
.metric.anchor dt,.metric.anchor dd small{color:#94A3B8}
.metric.anchor dd{color:var(--mint)}
.metric .tag{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:9999px;font-size:10px;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase;margin-left:6px;vertical-align:middle}
.tag-amber{background:var(--amber);color:var(--onyx)}
.tag-cyan{background:var(--cyan);color:var(--onyx)}

/* Steps */
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:32px;counter-reset:step;list-style:none}
.step{padding:24px}
.step::before{counter-increment:step;content:counter(step,decimal-leading-zero);display:inline-grid;place-items:center;
  width:40px;height:40px;border-radius:8px;background:var(--onyx);color:#FFFFFF;font-family:var(--mono);font-size:14px;font-weight:800;margin-bottom:16px}
.step h3{font-size:17px;letter-spacing:-.005em;margin-bottom:6px}
.step p{color:var(--body);font-size:14px}

footer{border-top:1px solid var(--line);background:var(--surface);padding:28px 0 36px;color:var(--muted);font-size:13px}
footer .wrap{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
footer a{display:inline-flex;align-items:center;min-height:48px;color:var(--body);font-weight:600}
footer a:hover{color:var(--onyx);text-decoration:underline;text-decoration-color:var(--coral)}
.brand-logo{display:block;flex:none}
.footer-brand{display:inline-flex;align-items:center;gap:8px}

@media (max-width:1024px){
  .wrap{padding:0 24px}
  .hero{grid-template-columns:1fr}
  .hero > div,.hero > figure{grid-column:auto}
  .calc{grid-template-columns:1fr}
  .steps{grid-template-columns:repeat(2,1fr)}
  .nav-links{display:none}
  .nav .btn{margin-left:auto}
}
@media (max-width:640px){
  .wrap{padding:0 16px}
  .hero{padding-top:48px;padding-bottom:48px}
  .panel,.metrics,.steps{grid-template-columns:1fr}
  .brand-tag{display:none}
  .tabs{display:flex}
  .tab{flex:1}
}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  .wire line{animation:none}
  .btn,.feature{transition:none}
}
`;

// ---------- Client script (vanilla; no backticks or template placeholders inside) ----------

const SCRIPT = `
(function(){
  var cfg = JSON.parse(document.getElementById('mk-config').textContent);
  var a = cfg.assumptions;
  var $ = function(id){ return document.getElementById(id); };

  /* Tabs: click, arrow keys, and #marcas / #creadores deep links */
  var tabs = [$('tab-marcas'), $('tab-creadores')];
  var panels = [$('panel-marcas'), $('panel-creadores')];
  function select(i, focus){
    for (var j = 0; j < tabs.length; j++) {
      var on = j === i;
      tabs[j].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[j].setAttribute('tabindex', on ? '0' : '-1');
      if (on) panels[j].removeAttribute('hidden'); else panels[j].setAttribute('hidden', '');
    }
    if (focus) tabs[i].focus();
  }
  tabs.forEach(function(tab, i){
    tab.addEventListener('click', function(){ select(i, false); });
    tab.addEventListener('keydown', function(e){
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        select((i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length, true);
      }
    });
  });
  function fromHash(){
    if (location.hash === '#creadores') select(1, false);
    else if (location.hash === '#marcas') select(0, false);
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();

  /* ROI calculator: same math as computeRoi() on the server */
  var fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 });
  function computeRoi(gross){
    var g = Math.min(a.maxGross, Math.max(a.minGross, Math.round(gross)));
    var net = Math.round(g * (1 - a.buyerDiscountRate));
    return {
      gross: g,
      net: net,
      commission: Math.round(net * a.commissionRate),
      leakageSavings: Math.round(g * a.leakedOrderShare * a.buyerDiscountRate)
    };
  }
  var slider = $('calc-slider'), category = $('calc-category');
  function render(){
    var r = computeRoi(Number(slider.value));
    $('calc-gross').textContent = fmt.format(r.gross);
    $('out-net').textContent = fmt.format(r.net);
    $('out-commission').textContent = fmt.format(r.commission);
    $('out-savings').textContent = fmt.format(r.leakageSavings);
    slider.setAttribute('aria-valuetext', fmt.format(r.gross) + ' MXN al mes');
  }
  function renderEscrow(){
    var days = cfg.escrowDays[category.value];
    $('out-escrow').textContent = String(days);
  }
  slider.addEventListener('input', render);
  category.addEventListener('change', renderEscrow);
  render();
  renderEscrow();
})();
`;

// ---------- Page ----------

export function renderMarketingHomePage(opts: { nonce: string; demoLinkSlug?: string }): string {
  const demoHref = opts.demoLinkSlug ? `/r/${encodeURIComponent(opts.demoLinkSlug)}` : '#como-funciona';
  const a = ROI_ASSUMPTIONS;
  const initial = computeRoi(a.defaultGross);
  const defaultCategory = ESCROW_CATEGORY_OPTIONS[0]!;
  const config = safeJsonForHtml({
    assumptions: a,
    escrowDays: Object.fromEntries(ESCROW_CATEGORY_OPTIONS.map((c) => [c.value, c.days])),
  });
  const pct = (r: number) => `${Math.round(r * 100)}%`;

  const categoryOptions = ESCROW_CATEGORY_OPTIONS.map(
    (c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)} · ${c.days} días</option>`,
  ).join('');

  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#FFFFFF">
<title>Referrals · Microinfluencers que venden en tu Shopify, sin costos fijos</title>
<meta name="description" content="Atribución determinística para Shopify México: cupones de un solo uso, escrow contra devoluciones y guiones de TikTok con IA. Solo pagas comisión sobre venta neta cobrada.">
<meta property="og:title" content="Referrals · Microinfluencers que venden en tu Shopify">
<meta property="og:description" content="Cupones de un solo uso, escrow anti-devoluciones y guiones con IA. Sin costos fijos.">
<meta property="og:type" content="website">
<link rel="icon" type="image/svg+xml" href="${brandFaviconHref()}">
<style nonce="${opts.nonce}">${STYLES}</style>
</head>
<body>

<header class="nav" id="top">
  <div class="wrap">
    <a class="brand" href="/" aria-label="Referrals, inicio">
      ${renderBrandLogo({ size: 32 })}Referrals
      <span class="brand-tag">⚡ LATAM E-Commerce</span>
    </a>
    <nav class="nav-links" aria-label="Secciones">
      <a href="#marcas">Solución para Marcas</a>
      <a href="#creadores">Creadores</a>
      <a href="#tecnologia">Tecnología</a>
      <a href="#calculadora">Calculadora</a>
    </nav>
    <a class="btn btn-primary btn-sm" href="${escapeHtml(demoHref)}">Ver Demo en Vivo</a>
  </div>
</header>

<main>
  <div class="wrap hero">
    <div>
      <span class="badge">🇲🇽 La primera red de atribución determinística para Shopify México</span>
      <h1>Convierte microinfluencers en tu canal <em>#1 de ventas</em> en Shopify. Sin costos fijos.</h1>
      <p class="lead">Cupones dinámicos de un solo uso que Honey no puede robar, 14 a 28 días de protección contra devoluciones (Escrow) y guiones virales de TikTok redactados por IA en 3 segundos.</p>
      <div class="actions">
        <a class="btn btn-primary" id="cta-demo" href="${escapeHtml(demoHref)}">Probar Demo de Comprador</a>
        <a class="btn btn-ghost" href="#calculadora">Calcular ROI</a>
      </div>
      <div class="proof">
        <div><strong class="num">$0</strong>costo fijo mensual</div>
        <div><strong class="num">14–28</strong>días de escrow</div>
        <div><strong class="num">1</strong>uso por cupón</div>
      </div>
    </div>

    <figure class="card bridge" aria-label="El puente: tu tienda Shopify, Referrals y el creador">
      <div class="node">
        <span class="icon i-shop" aria-hidden="true">S</span>
        <div><strong>Tu tienda Shopify</strong><small>glow-shop.myshopify.com</small></div>
        <span class="meta">Webhook<br><span class="mono">orders/paid</span></span>
      </div>
      <svg class="wire" viewBox="0 0 2 34" aria-hidden="true"><line x1="1" y1="0" x2="1" y2="34"/></svg>
      <div class="node">
        ${renderBrandLogo({ size: 40, className: 'brand-logo icon' })}
        <div><strong>Referrals</strong><small>Atribución determinística + Escrow</small></div>
        <span class="meta num">Escrow<br>14 días</span>
      </div>
      <svg class="wire" viewBox="0 0 2 34" aria-hidden="true"><line x1="1" y1="0" x2="1" y2="34"/></svg>
      <div class="node">
        <span class="icon i-creator" aria-hidden="true">V</span>
        <div><strong>@valeria.glow</strong><small>Microinfluencer · Belleza</small></div>
        <span class="meta num">Comisión<br>15%</span>
      </div>
      <div class="ticket">
        <code class="num">REF-VALER-7K2M</code>
        <span class="chip">1 solo uso</span>
      </div>
    </figure>
  </div>

  <section class="section" id="puente" aria-labelledby="puente-title">
    <div class="wrap">
      <span class="eyebrow">El Puente</span>
      <h2 id="puente-title">Un mismo flujo, dos lados ganando.</h2>
      <p class="section-lead">La marca solo paga por ventas cobradas. El creador cobra con certeza. El comprador recibe su descuento al instante.</p>

      <span id="marcas"></span><span id="creadores"></span>
      <div class="tabs" role="tablist" aria-label="Beneficios por tipo de usuario">
        <button class="tab" role="tab" id="tab-marcas" aria-selected="true" aria-controls="panel-marcas" tabindex="0">Marcas Shopify</button>
        <button class="tab" role="tab" id="tab-creadores" aria-selected="false" aria-controls="panel-creadores" tabindex="-1">Microinfluencers</button>
      </div>

      <div class="panel" role="tabpanel" id="panel-marcas" aria-labelledby="tab-marcas">
        <article class="card feature"><span class="k num">$0 / mes</span><h3>0 Costo Fijo</h3><p>Solo pagas comisión sobre venta neta cobrada.</p></article>
        <article class="card feature"><span class="k num">14–28 días</span><h3>Escrow Anti-Devoluciones</h3><p>Si el cliente devuelve o cancela, la comisión no se paga.</p></article>
        <article class="card feature"><span class="k">REF-XXXX-XXXX</span><h3>Cupones Anti-Fuga</h3><p>Códigos de 1 solo uso inyectados automáticamente en Shopify GraphQL.</p></article>
        <article class="card feature"><span class="k">HMAC-SHA256</span><h3>Conexión en 3 clics</h3><p>Vía Webhooks seguros HMAC-SHA256.</p></article>
      </div>

      <div class="panel" role="tabpanel" id="panel-creadores" aria-labelledby="tab-creadores" hidden>
        <article class="card feature"><span class="k">IA</span><h3>Guion Viral de TikTok / Reels</h3><p>Generado con IA para tu estilo.</p></article>
        <article class="card feature"><span class="k">SPEI · CLABE</span><h3>Pagos automáticos por SPEI</h3><p>Directo a tu CLABE interbancaria (Banxico).</p></article>
        <article class="card feature"><span class="k">1 clic</span><h3>Link personalizado con cupón</h3><p>Se autoaplica con 1 clic en el carrito.</p></article>
      </div>
    </div>
  </section>

  <section class="section" id="calculadora" aria-labelledby="calc-title">
    <div class="wrap">
      <span class="eyebrow">Calculadora</span>
      <h2 id="calc-title">Lo que generan tus creadores, en números.</h2>
      <p class="section-lead">Mueve el control y ve cuánto vende tu red de microinfluencers, cuánto pagas en comisión y cuánto margen dejas de regalar a extensiones de cupones.</p>

      <div class="calc">
        <div class="card calc-input">
          <label for="calc-slider">Ventas mensuales estimadas vía creadores</label>
          <div class="calc-gross num" id="calc-gross" aria-live="polite">${escapeHtml(formatMxn(initial.gross))}</div>
          <input type="range" id="calc-slider" name="gross" min="${a.minGross}" max="${a.maxGross}" step="${a.step}" value="${a.defaultGross}">
          <div class="range-scale num"><span>${escapeHtml(formatMxn(a.minGross))}</span><span>${escapeHtml(formatMxn(a.maxGross))}</span></div>
          <label for="calc-category" class="mt">Categoría de producto</label>
          <select id="calc-category" name="category">${categoryOptions}</select>
          <p class="assumptions">Supuestos: descuento al comprador ${pct(a.buyerDiscountRate)}, comisión al creador ${pct(a.commissionRate)} sobre venta neta, y ${pct(a.leakedOrderShare)} de pedidos con cupón público capturados por extensiones tipo Honey. Cifras ilustrativas, no una garantía de resultados.</p>
        </div>

        <dl class="metrics" aria-live="polite">
          <div class="card metric well"><dt>Venta Neta Generada</dt><dd class="num"><span id="out-net">${escapeHtml(formatMxn(initial.net))}</span><small>MXN</small></dd></div>
          <div class="card metric anchor"><dt>Comisión para Creadores (${pct(a.commissionRate)})</dt><dd class="num"><span id="out-commission">${escapeHtml(formatMxn(initial.commission))}</span><small>MXN</small></dd></div>
          <div class="card metric"><dt>Ahorro estimado en cupones no canibalizados<span class="tag tag-cyan">Estimado</span></dt><dd class="num"><span id="out-savings">${escapeHtml(formatMxn(initial.leakageSavings))}</span><small>MXN</small></dd></div>
          <div class="card metric"><dt>Días de garantía Escrow<span class="tag tag-amber">Escrow</span></dt><dd class="num"><span id="out-escrow">${defaultCategory.days}</span><small>días</small></dd></div>
        </dl>
      </div>
    </div>
  </section>

  <section class="section" id="tecnologia" aria-labelledby="steps-title">
    <div class="wrap" id="como-funciona">
      <span class="eyebrow">Cómo funciona</span>
      <h2 id="steps-title">De tu catálogo al SPEI, en cuatro pasos.</h2>
      <ol class="steps">
        <li class="card step"><h3>Conecta tu Shopify en 3 minutos.</h3><p>Credenciales cifradas y webhooks registrados automáticamente.</p></li>
        <li class="card step"><h3>La IA analiza tu catálogo y redacta los guiones virales.</h3><p>Hook, problema, solución y llamado a la acción, listos para grabar.</p></li>
        <li class="card step"><h3>Los creadores comparten su link exclusivo.</h3><p>Cada link lleva a una página ligera, pensada para el celular.</p></li>
        <li class="card step"><h3>Cada comprador recibe un cupón único y el dinero se liquida por SPEI tras el escrow.</h3><p>La venta se atribuye por el cupón, sin cookies ni adivinanzas.</p></li>
      </ol>
    </div>
  </section>
</main>

<footer>
  <div class="wrap">
    <span class="footer-brand">${renderBrandLogo({ size: 20 })}<span>© 2026 Referrals Inc. Infraestructura de atribución determinística para e-commerce en México y LATAM.</span></span>
    <a href="#top">Volver arriba</a>
  </div>
</footer>

<script type="application/json" id="mk-config">${config}</script>
<script nonce="${opts.nonce}">${SCRIPT}</script>
</body>
</html>`;
}
