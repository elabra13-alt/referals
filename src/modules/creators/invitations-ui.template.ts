import type { InvitationPageView } from '../matchmaker/invitations.service.js';
import {
  BUYER_CLIENT_KIT_JS,
  brandFaviconHref,
  escapeHtml,
  formatPrice,
  renderBrandLogo,
  renderProductThumb,
  safeJsonForHtml,
} from '../links/landing-template.js';
import { formatExpiry } from '../notifications/whatsapp.service.js';

/**
 * Mobile invitation page (/c/invitations/:id), opened from the creator's
 * WhatsApp notice: server-rendered, flat Solid Slate design (no gradients),
 * inline CSS/JS under the per-request CSP nonce. The accept/decline forms are
 * plain POSTs (works without JavaScript); with JS they submit inline and the
 * page switches to the celebration state without a reload.
 */

const ANGLE_LABELS = { problema: 'Problema', prueba: 'Prueba', oferta: 'Oferta' } as const;

const CATEGORY_LABELS: Record<string, string> = {
  beauty: 'Belleza',
  skincare: 'Skincare',
  consumables: 'Consumibles',
  fashion: 'Moda',
  footwear: 'Calzado',
  apparel: 'Ropa',
  electronics: 'Electrónica',
  audio: 'Audio',
  home: 'Hogar',
  general: 'General',
};

function categoryLabel(category: string): string {
  const key = category.trim().toLowerCase();
  return CATEGORY_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Plain-text script the "Copiar guion" button puts on the clipboard. */
export function scriptText(view: InvitationPageView): string {
  const { hooks } = view.invitation;
  return [
    `Guion · ${view.invitation.product.name}`,
    ...hooks.hooks.map((h, i) => `${i + 1}. ${ANGLE_LABELS[h.angle]}: ${h.hook}\n   En pantalla: ${h.on_screen_text}`),
    `Tip: ${hooks.tip}`,
    `Incluye siempre: ${hooks.disclosure}`,
  ].join('\n');
}

const STYLES = `
:root{
  --canvas:#F8FAFC;--surface:#FFFFFF;--well:#F1F5F9;--line:#E2E8F0;
  --onyx:#0F141C;--body:#334155;--muted:#475569;
  --coral:#FE2C55;--berry:#D62976;--cyan:#00B4D8;--mint:#10B981;--amber:#F59E0B;--danger:#991B1B;
  --font-display:'Plus Jakarta Sans',Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --font-body:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--font-body);background:var(--canvas);color:var(--body);line-height:1.5;min-height:100vh;
  display:flex;flex-direction:column;align-items:center;-webkit-font-smoothing:antialiased}
h1,h2,strong{font-family:var(--font-display);color:var(--onyx)}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on}
.top{width:100%;background:var(--surface);border-bottom:1px solid var(--line);padding:10px 16px;
  display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-weight:800;color:var(--onyx)}
main{width:100%;max-width:560px;padding:16px 16px 32px;display:flex;flex-direction:column;gap:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px}
.hidden{display:none}
.muted{color:var(--muted);font-size:14px}

/* Product */
.product{display:flex;gap:14px;align-items:center}
.tile{flex:none;width:72px;height:72px;border-radius:12px;background:var(--berry);color:#FFFFFF;display:grid;place-items:center;
  font-family:var(--font-display);font-weight:800;font-size:26px;object-fit:cover;border:1px solid var(--line)}
.brand{font-size:14px;font-weight:700;color:var(--berry);text-transform:uppercase;letter-spacing:.06em}
h1{font-size:22px;line-height:28px;letter-spacing:-.01em}
.meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px}
.pill{display:inline-flex;align-items:center;min-height:28px;padding:0 10px;border-radius:9999px;font-size:13px;font-weight:700}
.pill-cat{background:var(--well);color:var(--onyx);border:1px solid var(--line)}

/* Payout: Onyx on solid Mint (7:1) */
.payout{background:var(--mint);border-radius:12px;padding:18px 16px;color:var(--onyx);display:flex;flex-direction:column;gap:10px}
.payout-amount{font-family:var(--font-display);font-size:26px;line-height:32px;font-weight:800;color:var(--onyx)}
.escrow{align-self:flex-start;display:inline-flex;align-items:center;min-height:32px;padding:0 12px;border-radius:9999px;
  background:var(--amber);color:var(--onyx);font-weight:800;font-size:14px;border:1px solid var(--onyx)}

/* Seller note */
.note h2,.hooks h2,.state h2{font-size:18px;line-height:24px;margin-bottom:8px}
.note blockquote{border-left:3px solid var(--berry);padding-left:12px;color:var(--onyx);font-size:16px}

/* Hooks */
.hooks ol{list-style:none;display:flex;flex-direction:column;gap:12px;margin-bottom:12px}
.hook{border:1px solid var(--line);border-radius:10px;padding:12px}
.angle{display:inline-flex;align-items:center;min-height:26px;padding:0 10px;border-radius:9999px;font-size:12px;font-weight:800;
  letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px}
/* Accent as a solid border, label in Onyx on white: AAA at small sizes */
.angle{background:var(--surface);color:var(--onyx);border:2px solid var(--onyx)}
.angle-problema{border-color:var(--coral)}
.angle-prueba{border-color:var(--cyan)}
.angle-oferta{border-color:var(--amber)}
.hook-text{color:var(--onyx);font-size:16px;font-weight:600}
.disclosure{font-size:14px;color:var(--onyx);background:var(--well);border-radius:8px;padding:10px 12px;margin-bottom:12px}

/* Buttons: 48px+ targets, solid fills */
.btn{appearance:none;border:0;border-radius:8px;min-height:56px;padding:12px 16px;font-family:var(--font-display);
  font-size:18px;font-weight:800;cursor:pointer;width:100%;text-align:center;text-decoration:none;
  display:flex;align-items:center;justify-content:center}
.btn:focus-visible{outline:3px solid var(--onyx);outline-offset:2px}
.btn:disabled{opacity:.6;cursor:wait}
.btn-accept{background:var(--mint);color:var(--onyx);border:2px solid var(--onyx)}
.btn-accept:hover{background:var(--onyx);color:#FFFFFF}
.btn-secondary{background:var(--surface);color:var(--onyx);border:1px solid var(--onyx);min-height:48px;font-size:16px}
.btn-secondary:hover{background:var(--well)}
.btn-dark{background:var(--onyx);color:#FFFFFF}
.actions{display:flex;flex-direction:column;gap:10px}
.actions form{display:block}
.error{color:var(--danger);font-size:14px;font-weight:600}
.error:empty{display:none}

/* States */
.celebrate{border:2px solid var(--onyx)}
.celebrate h2{font-size:22px;line-height:28px}
.link-box{display:flex;flex-direction:column;gap:8px;background:var(--well);border:1px solid var(--line);border-radius:10px;
  padding:12px;margin:12px 0}
.link{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:15px;font-weight:700;color:var(--onyx);word-break:break-all}
.stack{display:flex;flex-direction:column;gap:10px}

footer{color:var(--muted);font-size:12px;text-align:center;padding:0 16px 24px}
.powered{display:inline-flex;align-items:center;gap:6px}
.brand-logo{display:block;flex:none}
`;

const SCRIPT = `
(function(){
  var cfg = JSON.parse(document.getElementById('inv-config').textContent);
  var $ = function(id){ return document.getElementById(id); };
${BUYER_CLIENT_KIT_JS}
  function copyText(text, button, fallbackEl){
    var label = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', label);
    function done(ok){
      if (!ok) selectNode(fallbackEl);
      button.textContent = ok ? '¡Copiado!' : 'Selecciona y copia';
      setTimeout(function(){ button.textContent = label; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function(){ done(true); }, function(){ done(legacyCopy(text)); });
    } else {
      done(legacyCopy(text));
    }
  }

  var scriptBtn = $('inv-copy-script');
  if (scriptBtn) scriptBtn.addEventListener('click', function(){ copyText(cfg.script, scriptBtn, $('inv-hooks-list')); });
  var linkBtn = $('inv-copy-link');
  linkBtn.addEventListener('click', function(){ copyText($('inv-link').textContent, linkBtn, $('inv-link')); });

  var MESSAGES = {
    INVITATION_EXPIRED: 'Esta invitación ya venció.',
    CAMPAIGN_NOT_ACTIVE: 'Esta campaña ya no está activa.',
    INVITATION_DECLINED: 'Ya declinaste esta invitación.',
    INVITATION_ALREADY_ACCEPTED: 'Ya aceptaste esta invitación.',
    SESSION_EXPIRED: 'Tu sesión venció. Abre de nuevo el enlace de WhatsApp.'
  };
  var isWebUrl = function(u){ return typeof u === 'string' && (u.indexOf('https://') === 0 || u.indexOf('http://') === 0); };

  function show(id){
    ['inv-actions', 'inv-accepted', 'inv-declined'].forEach(function(s){ var el = $(s); if (el) el.classList.toggle('hidden', s !== id); });
    var heading = $(id) && $(id).querySelector('h2');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
  }
  function showAccepted(body){
    $('inv-link').textContent = body.link_url;
    if (isWebUrl(body.storefront_url)) $('inv-storefront').setAttribute('href', body.storefront_url);
    show('inv-accepted');
  }

  var err = $('inv-error');
  Array.prototype.forEach.call(document.querySelectorAll('form[data-action]'), function(form){
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var action = form.getAttribute('data-action');
      var buttons = document.querySelectorAll('#inv-actions button');
      var btn = form.querySelector('button'), label = btn.textContent;
      Array.prototype.forEach.call(buttons, function(b){ b.disabled = true; });
      btn.textContent = action === 'accept' ? 'Publicando…' : 'Guardando…';
      err.textContent = '';
      fetch(cfg.respondPath, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action: action, csrf: cfg.csrf })
      }).then(function(res){
        return res.json().catch(function(){ return {}; }).then(function(body){ return { status: res.status, body: body }; });
      }).then(function(r){
        if (r.status >= 200 && r.status < 300) return action === 'accept' ? showAccepted(r.body) : show('inv-declined');
        var code = r.body && r.body.error && r.body.error.code;
        err.textContent = MESSAGES[code] || 'No pudimos guardar tu respuesta. Intenta de nuevo.';
      }).catch(function(){
        err.textContent = 'Sin conexión. Revisa tu internet e intenta de nuevo.';
      }).then(function(){
        Array.prototype.forEach.call(buttons, function(b){ b.disabled = false; });
        btn.textContent = label;
      });
    });
  });
})();
`;

function shell(opts: { title: string; nonce: string; body: string }): string {
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#FFFFFF">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(opts.title)}</title>
<link rel="icon" type="image/svg+xml" href="${brandFaviconHref()}">
<style nonce="${opts.nonce}">${STYLES}</style>
</head>
<body>
<header class="top">${renderBrandLogo({ size: 24 })}Referrals</header>
${opts.body}
<footer><span class="powered">${renderBrandLogo({ size: 16 })}Invitaciones para creadores · Referrals</span></footer>
</body>
</html>`;
}

export function renderInvitationPage(view: InvitationPageView, opts: { nonce: string; csrf: string; respondPath: string }): string {
  const inv = view.invitation;
  const brand = escapeHtml(inv.brand.name);
  const respondPath = escapeHtml(opts.respondPath);
  const hidden = (show: boolean) => (show ? '' : ' hidden');

  const hooks = inv.hooks.hooks
    .map(
      (h) => `
      <li class="hook">
        <span class="angle angle-${h.angle}">${ANGLE_LABELS[h.angle]}</span>
        <p class="hook-text">“${escapeHtml(h.hook)}”</p>
        <p class="muted">En pantalla: ${escapeHtml(h.on_screen_text)}</p>
      </li>`,
    )
    .join('');

  const form = (action: 'accept' | 'decline', cls: string, label: string) => `
      <form method="post" action="${respondPath}" data-action="${action}">
        <input type="hidden" name="action" value="${action}">
        <input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
        <button class="btn ${cls}" type="submit">${label}</button>
      </form>`;

  const closedMessage =
    inv.status === 'expired'
      ? ['Esta invitación venció', 'Pídele a la marca que te la vuelva a enviar si te interesa.']
      : inv.status === 'pending' && !inv.can_accept
        ? ['Esta campaña ya no está activa', 'La marca pausó o cerró esta campaña.']
        : null;

  const actionsOrState = closedMessage
    ? `<section class="card state"><h2>${closedMessage[0]}</h2><p class="muted">${closedMessage[1]}</p></section>`
    : `<section class="card state actions${hidden(inv.status === 'pending')}" id="inv-actions">
      <p class="error" id="inv-error" role="alert" aria-live="assertive"></p>
      ${form('accept', 'btn-accept', 'Aceptar y publicar en mi vitrina')}
      ${form('decline', 'btn-secondary', 'Declinar invitación')}
      <p class="muted">Responde antes del <span class="num">${escapeHtml(formatExpiry(new Date(inv.expires_at)))}</span>.</p>
    </section>`;

  const accepted = view.accepted;
  const body = `
<main>
  <section class="card product">
    ${renderProductThumb(inv.product.name, inv.product.image_url, { className: 'tile', size: 72 })}
    <div>
      <p class="brand">${brand} te invita</p>
      <h1>${escapeHtml(inv.product.name)}</h1>
      <div class="meta"><span class="pill pill-cat">${escapeHtml(categoryLabel(inv.product.category))}</span><span class="muted num">Precio ${escapeHtml(formatPrice(inv.product.price, inv.product.currency))}</span></div>
    </div>
  </section>

  <section class="payout" aria-label="Tu comisión">
    <p class="payout-amount num">Ganas ${escapeHtml(formatPrice(inv.estimated_earnings_per_sale, inv.product.currency))} por venta</p>
    <span class="escrow num">${inv.escrow_days} días de custodia garantizada</span>
  </section>

  ${
    inv.custom_note
      ? `<section class="card note"><h2>Nota de ${brand}</h2><blockquote>${escapeHtml(inv.custom_note)}</blockquote></section>`
      : ''
  }

  <section class="card hooks">
    <h2>3 ideas para tu video</h2>
    <ol id="inv-hooks-list">${hooks}
    </ol>
    <p class="disclosure">Incluye siempre: ${escapeHtml(inv.hooks.disclosure)}</p>
    <button class="btn btn-secondary" id="inv-copy-script" type="button">Copiar guion</button>
  </section>

  ${actionsOrState}

  <section class="card state celebrate${hidden(inv.status === 'accepted')}" id="inv-accepted" aria-live="polite">
    <h2>¡Listo! Ya está en tu vitrina</h2>
    <p class="muted">Comparte tu link: cada comprador recibe un cupón único y tú ganas por cada venta.</p>
    <div class="link-box">
      <span class="link" id="inv-link">${escapeHtml(accepted?.link_url ?? '')}</span>
      <button class="btn btn-dark" id="inv-copy-link" type="button">Copiar mi link</button>
    </div>
    <div class="stack">
      <a class="btn btn-secondary" id="inv-storefront" href="${escapeHtml(accepted?.storefront_url ?? '#')}">Ver mi vitrina</a>
    </div>
  </section>

  <section class="card state${hidden(inv.status === 'declined')}" id="inv-declined" aria-live="polite">
    <h2>Invitación declinada</h2>
    <p class="muted">Le avisamos a ${brand}. No volverá a invitarte a esta campaña.</p>
  </section>
</main>
<script type="application/json" id="inv-config">${safeJsonForHtml({ respondPath: opts.respondPath, csrf: opts.csrf, script: scriptText(view) })}</script>
<script nonce="${opts.nonce}">${SCRIPT}</script>`;

  return shell({ title: `${inv.brand.name} te invita · ${inv.product.name} | Referrals`, nonce: opts.nonce, body });
}

export type InvitationErrorKind = 'invalid' | 'expired' | 'session';

const ERROR_COPY: Record<InvitationErrorKind, [string, string]> = {
  invalid: ['Enlace no válido', 'Este enlace de invitación no es válido. Ábrelo directamente desde tu mensaje de WhatsApp.'],
  expired: ['Esta invitación venció', 'El enlace ya no está activo. Pídele a la marca que te vuelva a invitar.'],
  session: ['Abre tu invitación desde WhatsApp', 'Por seguridad, entra con el enlace de tu mensaje de WhatsApp para ver esta invitación.'],
};

export function renderInvitationErrorPage(kind: InvitationErrorKind, opts: { nonce: string }): string {
  const [title, message] = ERROR_COPY[kind];
  return shell({
    title: `${title} | Referrals`,
    nonce: opts.nonce,
    body: `
<main><section class="card state"><h1>${title}</h1><p class="muted">${message}</p></section></main>`,
  });
}
