import type { LinkAvailability } from './link-availability.js';
import type { LinkPreviewDto } from './links.schemas.js';

/**
 * Buyer landing page (AGENTS.md §4): server-rendered, self-contained (inline
 * CSS/JS, no external fonts or scripts), so first paint needs one request.
 * Every value from the database is HTML-escaped, and the JSON config is
 * escaped against `</script>` breakouts. Scripts and styles run only under the
 * per-request CSP nonce.
 */

// ---------- Escaping ----------

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** JSON safe to embed inside <script type="application/json">. */
export function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ---------- Brand logo (inline SVG; no external images) ----------

/**
 * The Referrals mark (Kinetic Commercial Nexus): a flat Deep Onyx tile with a
 * geometric white "R" whose leg is Fresh Mint, the payout. Solid fills only:
 * no gradients, no filters, and no ids, so any number of logos can share a page.
 */
export function renderBrandLogo(opts: { size?: number; className?: string } = {}): string {
  const size = opts.size ?? 32;
  return `<svg class="${opts.className ?? 'brand-logo'}" viewBox="0 0 40 40" width="${size}" height="${size}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="40" height="40" rx="10" fill="#0F141C"/>
  <path d="M11 9h11.5a7.5 7.5 0 0 1 0 15H16v7h-5V9zm5 5v5h6.5a2.5 2.5 0 0 0 0-5H16z" fill="#FFFFFF"/>
  <path d="M19.6 24h5.8l5.6 7h-5.8l-5.6-7z" fill="#10B981"/>
</svg>`;
}

/** Same mark as a self-contained data: URI favicon (allowed by the pages' `img-src 'self' data:`). */
export function brandFaviconHref(): string {
  return `data:image/svg+xml,${encodeURIComponent(renderBrandLogo({ size: 64 }))}`;
}

export function formatPrice(price: string, currency: string): string {
  const amount = new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
  }).format(Number(price));
  return `${amount} ${currency}`;
}

// ---------- Design tokens: "Kinetic Commercial Nexus" (stitch_design/DESIGN.md) ----------
// 100% flat solid fields: no gradients, blurs or shadows; depth comes from surface tiers and solid borders.
// Contrast (WCAG): text on Mint/Cyan/Amber is Deep Onyx (white would be ~2.5:1); white on Coral (3.7:1)
// is only used at large-text size (>= 18.66px bold); body copy is Onyx/#334155 (AAA).

const STYLES = `
:root{
  --canvas:#F8FAFC;--surface:#FFFFFF;--well:#F1F5F9;--line:#E2E8F0;
  --onyx:#0F141C;--body:#334155;--muted:#64748B;
  --coral:#FE2C55;--coral-hover:#E02449;--coral-active:#C81E3F;
  --berry:#D62976;--cyan:#00B4D8;--mint:#10B981;--mint-600:#059669;--amber:#F59E0B;
  --danger:#991B1B;
  --font-display:'Plus Jakarta Sans',Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --font-body:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--font-body);background:var(--canvas);color:var(--body);line-height:1.5;min-height:100vh;
  display:flex;flex-direction:column;align-items:center;-webkit-font-smoothing:antialiased}
h1,h2,strong{font-family:var(--font-display);color:var(--onyx)}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on}

/* Header canopy: creator endorsement */
.top{width:100%;background:var(--surface);border-bottom:1px solid var(--line);padding:12px 16px;
  display:flex;align-items:center;gap:12px}
.top strong{font-size:16px;letter-spacing:-.01em}
.top small{display:block;color:var(--muted);font-size:12px;font-weight:600}
.avatar{width:44px;height:44px;border-radius:50%;background:var(--berry);color:#FFFFFF;flex:none;
  display:grid;place-items:center;font-family:var(--font-display);font-weight:800;font-size:16px}
.top .pill{margin-left:auto}

main{width:100%;max-width:440px;padding:16px 16px 32px;display:flex;flex-direction:column;gap:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px}
h1{font-size:22px;line-height:28px;letter-spacing:-.01em}
h2{font-size:18px;line-height:24px;letter-spacing:-.005em}
.muted{color:var(--muted);font-size:14px}
.lead{color:var(--body);font-size:14px}

/* Pills / status badges: solid fills, label-sm uppercase */
.pill,.badge{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:9999px;
  font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.badge,.pill-berry{background:var(--berry);color:#FFFFFF}
.pill-mint{background:var(--mint);color:var(--onyx)}
.badge{margin-bottom:10px}

.price{font-family:var(--font-display);font-size:28px;line-height:32px;font-weight:800;color:var(--onyx);
  letter-spacing:-.02em;margin-top:8px}

/* Lead capture */
form{display:flex;flex-direction:column;gap:12px}
label{font-size:14px;font-weight:600;color:var(--onyx)}
input[type=email],input[type=tel]{width:100%;height:48px;font-size:16px;padding:0 14px;border:1px solid var(--line);
  border-radius:8px;background:var(--surface);color:var(--onyx)}
input::placeholder{color:var(--muted)}
input[type=email]:focus,input[type=tel]:focus{outline:1px solid var(--coral);outline-offset:0;border-color:var(--coral)}
.check{display:flex;gap:10px;align-items:center;font-weight:500;color:var(--body);min-height:48px}
input[type=checkbox]{width:20px;height:20px;accent-color:var(--coral);flex:none}
input[type=checkbox]:focus-visible{outline:2px solid var(--onyx);outline-offset:2px}

/* Primary action: solid TikTok Coral, white text at large-text size */
.btn{appearance:none;border:0;border-radius:8px;min-height:52px;padding:12px 16px;font-family:var(--font-display);
  font-size:19px;font-weight:800;cursor:pointer;width:100%;background:var(--coral);color:#FFFFFF;text-align:center;
  text-decoration:none;display:flex;align-items:center;justify-content:center}
.btn:hover{background:var(--coral-hover)}
.btn:active{background:var(--coral-active)}
.btn:focus-visible{outline:3px solid var(--onyx);outline-offset:2px}
.btn:disabled{background:var(--muted);cursor:wait}

/* Revealed code: high-impact surface (2px Onyx edge) */
.result-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.code-box{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);
  border:2px solid var(--onyx);border-radius:12px;padding:14px 14px 14px 16px;margin:8px 0 12px}
.code-label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.code{display:block;font-family:var(--mono);font-size:26px;font-weight:800;letter-spacing:.04em;color:var(--onyx);white-space:nowrap}
/* Secondary action: white with Onyx border, inverts on hover */
.copy{flex:none;min-height:48px;min-width:96px;border:1px solid var(--onyx);border-radius:8px;background:var(--surface);
  color:var(--onyx);padding:0 14px;font-size:15px;font-weight:700;cursor:pointer}
.copy:hover,.copy:active{background:var(--onyx);color:#FFFFFF}
.copy:focus-visible{outline:3px solid var(--coral);outline-offset:2px}
/* Countdown: solid Amber with Onyx text (escrow / expiry semantics) */
.expiry{display:flex;align-items:center;gap:8px;color:var(--body);font-size:14px}
.timer{display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:9999px;background:var(--amber);
  color:var(--onyx);font-weight:800;font-size:14px}

.error{color:var(--danger);font-size:14px;font-weight:600;min-height:1em}
.hidden{display:none}
.mt{margin-top:10px}
.mt-lg{margin-top:16px}
footer{color:var(--muted);font-size:12px;text-align:center;padding:0 16px 24px}
.powered{display:inline-flex;align-items:center;gap:6px}
.brand-logo{display:block;flex:none}
/* Narrow phones: never break the code mid-string; stack Copy under it instead */
@media (max-width:430px){
  .code-box{flex-direction:column;align-items:stretch}
  .copy{width:100%}
}
`;

// ---------- Client script (vanilla, no dependencies) ----------

/**
 * Buyer-side helpers shared by every coupon page (link landing, creator
 * storefront): phone normalization, error copy, 48h countdown, and a 1-click
 * copy that degrades safely (async Clipboard API → execCommand → select for
 * manual copy) and never claims a copy that did not happen. Embedded inside
 * each page's IIFE; relies only on browser globals.
 */
export const BUYER_CLIENT_KIT_JS = `
  function normalizePhone(v){
    var digits = v.replace(/\\D/g, '');
    if (!digits) return null;
    if (/^\\s*\\+/.test(v)) return '+' + digits;
    return digits.length === 10 ? '+52' + digits : '+' + digits;
  }

  var ERROR_MESSAGES = {
    RATE_LIMITED: 'Demasiados intentos desde tu red. Intenta más tarde.',
    DISPOSABLE_EMAIL: 'Usa un correo permanente para recibir tu código.',
    LINK_INACTIVE: 'Esta promoción ya no está disponible.',
    LINK_NOT_FOUND: 'Esta promoción ya no está disponible.',
    PRODUCT_NOT_IN_STOREFRONT: 'Este producto ya no está disponible.',
    STOREFRONT_NOT_FOUND: 'Esta tienda ya no está disponible.',
    VALIDATION_ERROR: 'Revisa tu correo o teléfono.',
    REQUEST_IN_FLIGHT: 'Estamos generando tu código, intenta de nuevo en un momento.',
    DISCOUNT_PROVISIONING_FAILED: 'No pudimos activar tu código con la tienda. Intenta de nuevo.'
  };

  function pad(n){ return n < 10 ? '0' + n : '' + n; }
  function startCountdown(el, expiresAt){
    var end = Date.parse(expiresAt);
    function tick(){
      var s = Math.max(0, Math.floor((end - Date.now()) / 1000));
      el.textContent = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
      if (s === 0) clearInterval(t);
    }
    var t = setInterval(tick, 1000); tick();
  }

  /* Legacy copy for insecure HTTP (e.g. a LAN IP on a phone) or when the async API rejects.
     execCommand reports failure by returning false, not by throwing. */
  function legacyCopy(code){
    var ta = document.createElement('textarea');
    ta.value = code; ta.setAttribute('readonly', ''); ta.style.position = 'absolute'; ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    if (ta.setSelectionRange) ta.setSelectionRange(0, code.length); /* iOS Safari */
    var ok = false;
    try { ok = document.execCommand('copy') === true; } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  /* Last resort: highlight the code so a long-press / Ctrl+C copies it. */
  function selectNode(el){
    try {
      var range = document.createRange(); range.selectNodeContents(el);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    } catch (e) {}
  }
  /* Always resolves (true = copied), so a store redirect never waits on a failed copy. */
  function copyWithFeedback(code, button, codeEl){
    function feedback(ok){
      if (!ok) selectNode(codeEl);
      if (!button) return;
      button.textContent = ok ? '¡Copiado!' : 'Copia manual';
      setTimeout(function(){ button.textContent = 'Copiar'; }, 1800);
    }
    function fallback(){ var ok = legacyCopy(code); feedback(ok); return ok; }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      return navigator.clipboard.writeText(code).then(function(){ feedback(true); return true; }, fallback);
    }
    return Promise.resolve(fallback());
  }
`;

const SCRIPT = `
(function(){
  var cfg = JSON.parse(document.getElementById('ref-config').textContent);
  var $ = function(id){ return document.getElementById(id); };
  var form = $('ref-form'), btn = $('ref-submit'), err = $('ref-error');
  var phone = $('ref-phone'), wa = $('ref-wa');

${BUYER_CLIENT_KIT_JS}
  phone.addEventListener('input', function(){ wa.disabled = !phone.value.trim(); if (wa.disabled) wa.checked = false; });
  var MESSAGES = ERROR_MESSAGES;
  function startTimer(expiresAt){ startCountdown($('ref-timer'), expiresAt); }
  function copyCode(code, button){ return copyWithFeedback(code, button, $('ref-code')); }

  function showCode(data){
    $('ref-code').textContent = data.code;
    var go = $('ref-go');
    // Only ever navigate to http(s) URLs.
    if (/^https?:\\/\\//i.test(data.auto_apply_url)) go.setAttribute('href', data.auto_apply_url);
    go.addEventListener('click', function(e){
      e.preventDefault();
      var href = go.getAttribute('href');
      copyCode(data.code).then(function(){ if (href) window.location.assign(href); });
    });
    $('ref-copy').addEventListener('click', function(){ copyCode(data.code, $('ref-copy')); });
    startTimer(data.expires_at);
    $('ref-request').classList.add('hidden');
    $('ref-result').classList.remove('hidden');
    $('ref-code').focus();
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    err.textContent = '';
    var email = $('ref-email').value.trim() || null;
    var tel = normalizePhone(phone.value);
    if (!email && !tel) { err.textContent = 'Escribe tu correo o tu WhatsApp.'; return; }
    btn.disabled = true; btn.textContent = 'Generando…';
    fetch(cfg.codeRequestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        link_slug: cfg.linkSlug,
        buyer: { email: email, phone: tel, send_whatsapp_backup: !!(tel && wa.checked) },
        client_context: { user_agent: navigator.userAgent }
      })
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(body){ return { status: res.status, body: body }; });
    }).then(function(r){
      if (r.status === 201) return showCode(r.body);
      if (r.status === 409 && r.body.existing_code) return showCode(r.body.existing_code);
      var code = r.body && r.body.error && r.body.error.code;
      err.textContent = MESSAGES[code] || 'No pudimos generar tu código. Intenta de nuevo.';
    }).catch(function(){
      err.textContent = 'Sin conexión. Revisa tu internet e intenta de nuevo.';
    }).then(function(){
      btn.disabled = false; btn.textContent = 'Obtener mi código';
    });
  });
})();
`;

// ---------- Pages ----------

function shell(opts: { title: string; nonce: string; body: string; description?: string }): string {
  const description = opts.description ? `<meta name="description" content="${escapeHtml(opts.description)}">` : '';
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#FFFFFF">
<meta name="robots" content="noindex">
<title>${escapeHtml(opts.title)}</title>
${description}
<link rel="icon" type="image/svg+xml" href="${brandFaviconHref()}">
<style nonce="${opts.nonce}">${STYLES}</style>
</head>
<body>
${opts.body}
<footer><span class="powered">${renderBrandLogo({ size: 16 })}Código de un solo uso · Powered by Referrals</span></footer>
</body>
</html>`;
}

function initials(name: string): string {
  const parts = name.replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  return escapeHtml(((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'R');
}

export function renderLandingPage(preview: LinkPreviewDto, opts: { nonce: string; codeRequestUrl: string }): string {
  const creator = escapeHtml(preview.creator.handle ?? preview.creator.name);
  const product = escapeHtml(preview.product.name);
  const price = escapeHtml(formatPrice(preview.product.price, preview.product.currency));
  const config = safeJsonForHtml({ linkSlug: preview.link_slug, codeRequestUrl: opts.codeRequestUrl });

  const body = `
<header class="top">
  <div class="avatar" aria-hidden="true">${initials(preview.creator.name)}</div>
  <div><small>Recomendado por</small><strong>${creator}</strong></div>
  <span class="pill pill-berry">Recomendado</span>
</header>
<main>
  <section class="card">
    <span class="badge">Descuento exclusivo</span>
    <h1>${product}</h1>
    <p class="price num">${price}</p>
  </section>

  <section class="card" id="ref-request">
    <form id="ref-form" novalidate>
      <p class="muted">Recibe tu código al instante. Sin registro.</p>
      <label for="ref-email">Correo electrónico</label>
      <input id="ref-email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="tu@correo.com">
      <label for="ref-phone">o WhatsApp</label>
      <input id="ref-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="55 1234 5678">
      <label class="check"><input id="ref-wa" type="checkbox" disabled> Envíame un respaldo por WhatsApp</label>
      <p class="error" id="ref-error" role="alert" aria-live="assertive"></p>
      <button class="btn" id="ref-submit" type="submit">Obtener mi código</button>
    </form>
  </section>

  <section class="card hidden" id="ref-result" aria-live="polite">
    <div class="result-head">
      <h2>¡Cupón activado!</h2>
      <span class="pill pill-mint">Listo</span>
    </div>
    <div class="code-box">
      <div>
        <span class="code-label">Tu código de descuento</span>
        <span class="code num" id="ref-code" tabindex="-1"></span>
      </div>
      <button class="copy" id="ref-copy" type="button">Copiar</button>
    </div>
    <p class="expiry">Vence en <span class="timer num" id="ref-timer">48:00:00</span></p>
    <a class="btn mt-lg" id="ref-go" href="#" rel="noopener">Ir a la tienda con mi descuento</a>
    <p class="muted mt">Se aplica automáticamente al pagar.</p>
  </section>
</main>
<script type="application/json" id="ref-config">${config}</script>
<script nonce="${opts.nonce}">${SCRIPT}</script>`;

  return shell({
    title: `${preview.product.name} · Descuento de ${preview.creator.handle ?? preview.creator.name}`,
    description: `Obtén tu código de descuento para ${preview.product.name}.`,
    nonce: opts.nonce,
    body,
  });
}

const UNAVAILABLE_COPY: Record<'not_found' | Exclude<LinkAvailability, 'active'>, { title: string; message: string }> = {
  not_found: { title: 'Enlace no encontrado', message: 'Este enlace no existe. Revisa que esté bien escrito.' },
  link_expired: { title: 'Promoción terminada', message: 'Esta promoción ya expiró.' },
  link_paused: { title: 'Promoción en pausa', message: 'Esta promoción está pausada por el momento.' },
  campaign_inactive: { title: 'Promoción no disponible', message: 'Esta promoción ya no está activa.' },
  product_inactive: { title: 'Producto no disponible', message: 'Este producto ya no está disponible.' },
};

export function renderUnavailablePage(reason: keyof typeof UNAVAILABLE_COPY, opts: { nonce: string }): string {
  const copy = UNAVAILABLE_COPY[reason];
  return shell({
    title: copy.title,
    nonce: opts.nonce,
    body: `
<header class="top">${renderBrandLogo({ size: 40 })}<div><strong>Referrals</strong></div></header>
<main><section class="card"><h1>${escapeHtml(copy.title)}</h1><p class="muted mt">${escapeHtml(copy.message)}</p></section></main>`,
  });
}

// ---------- Product thumbnail (photo, or initials badge) ----------

export function productInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'R';
}

/**
 * The product photo when an https URL is on file, otherwise a solid initials
 * badge. Pages that use it must allow `img-src https:` in their CSP.
 */
export function renderProductThumb(name: string, imageUrl: string | null | undefined, opts: { className: string; size: number }): string {
  if (imageUrl && /^https:\/\//i.test(imageUrl)) {
    return `<img class="${opts.className}" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}" width="${opts.size}" height="${opts.size}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  }
  return `<div class="${opts.className}" aria-hidden="true">${escapeHtml(productInitials(name))}</div>`;
}
