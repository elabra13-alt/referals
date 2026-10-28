import type { HookSet } from '../catalog/hooks-generator.js';
import {
  BUYER_CLIENT_KIT_JS,
  brandFaviconHref,
  escapeHtml,
  formatPrice,
  renderBrandLogo,
  renderProductThumb,
  safeJsonForHtml,
} from '../links/landing-template.js';
import type { CreatorInvitationDto } from '../matchmaker/invitations.service.js';
import type { StorefrontItemDto } from '../storefront/storefront.schemas.js';
import type { BalanceDto, PayoutProfileDto, WithdrawalDto } from './payouts.service.js';
import { centsToDecimal } from '../../lib/money.js';
import { MIN_WITHDRAWAL_CENTS } from './payouts.service.js';

/**
 * Creator mobile portal: Mi Vitrina (/c/storefront), Mi Billetera (/c/wallet)
 * and Invitaciones (/c/invitations). Server-rendered, flat Solid Slate design
 * (no gradients), inline CSS/JS under the per-request CSP nonce. Every action
 * is a plain form POST that redirects back (works without JavaScript); the
 * script only adds 1-tap copy and a live CLABE check.
 */

export type PortalTab = 'storefront' | 'wallet' | 'invitations';

export interface Flash {
  kind: 'success' | 'error';
  message: string;
}

const ANGLE_LABELS = { problema: 'Problema', prueba: 'Prueba', oferta: 'Oferta' } as const;

const WITHDRAWAL_STATUS: Record<WithdrawalDto['status'], { label: string; cls: string }> = {
  pending: { label: 'Pendiente', cls: 'pill-amber' },
  processing: { label: 'En proceso', cls: 'pill-amber' },
  paid: { label: 'Completado', cls: 'pill-mint' },
  failed: { label: 'Fallido', cls: 'pill-danger' },
  cancelled: { label: 'Cancelado', cls: 'pill-neutral' },
};

const INVITATION_STATUS: Record<CreatorInvitationDto['status'], { label: string; cls: string }> = {
  pending: { label: 'Nueva', cls: 'pill-coral' },
  accepted: { label: 'Aceptada', cls: 'pill-mint' },
  declined: { label: 'Declinada', cls: 'pill-neutral' },
  expired: { label: 'Vencida', cls: 'pill-neutral' },
};

export const formatCents = (cents: number) => formatPrice(centsToDecimal(BigInt(cents)), 'MXN');

/** "0.1500" → "15%", "0.1250" → "12.5%". */
export const formatRate = (rate: string) => `${Number((Number(rate) * 100).toFixed(2))}%`;

/** Display reference for a withdrawal, e.g. WDR-3F2A9C1B (derived from its id). */
export const withdrawalReference = (id: string) => `WDR-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Mexico_City' }).format(new Date(iso));

const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Mexico_City',
  }).format(new Date(iso));

export function scriptFromHooks(productName: string, hooks: HookSet): string {
  return [
    `Guion · ${productName}`,
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
  display:flex;flex-direction:column;align-items:center;-webkit-font-smoothing:antialiased;
  padding-bottom:calc(72px + env(safe-area-inset-bottom))}
h1,h2,h3,strong{font-family:var(--font-display);color:var(--onyx)}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on}
.top{width:100%;background:var(--surface);border-bottom:1px solid var(--line);padding:10px 16px;
  display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-weight:800;color:var(--onyx)}
main{width:100%;max-width:560px;padding:16px 16px 24px;display:flex;flex-direction:column;gap:16px}
h1{font-size:24px;line-height:30px;letter-spacing:-.015em}
h2{font-size:18px;line-height:24px;margin-bottom:8px}
h3{font-size:17px;line-height:22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px}
.muted{color:var(--muted);font-size:14px}
.hidden{display:none}

/* Flash */
.flash{border-radius:10px;padding:12px 14px;font-weight:600;color:var(--onyx);border:2px solid var(--onyx)}
.flash-success{background:var(--mint)}
.flash-error{background:var(--surface);border-color:var(--danger);color:var(--danger)}

/* Pills: Onyx text on solid fills (AAA) */
.pill{display:inline-flex;align-items:center;min-height:26px;padding:0 10px;border-radius:9999px;font-size:12px;font-weight:800;
  letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;color:var(--onyx);border:1px solid var(--onyx)}
.pill-mint{background:var(--mint)}
.pill-amber{background:var(--amber)}
.pill-coral{background:var(--surface);border:2px solid var(--coral)}
.pill-neutral{background:var(--well);border-color:var(--line)}
.pill-danger{background:var(--surface);color:var(--danger);border-color:var(--danger)}
.pill-cyan{background:var(--cyan)}

/* Balances */
.balances{display:grid;grid-template-columns:1fr;gap:12px}
.balance{border-radius:12px;padding:16px;color:var(--onyx);border:1px solid var(--onyx)}
.balance-available{background:var(--mint)}
.balance-escrow{background:var(--amber)}
.balance-label{font-size:14px;font-weight:700}
.balance-amount{font-family:var(--font-display);font-size:30px;line-height:36px;font-weight:800;color:var(--onyx)}
.note{font-size:14px;color:var(--body);background:var(--well);border-radius:8px;padding:10px 12px}

/* Forms & buttons: 48px+ targets */
form{display:flex;flex-direction:column;gap:10px}
label{font-size:14px;font-weight:700;color:var(--onyx)}
input[type=text],input[type=tel]{width:100%;min-height:48px;font-size:17px;padding:0 14px;border:1px solid var(--onyx);border-radius:8px;
  background:var(--surface);color:var(--onyx)}
input:focus{outline:3px solid var(--cyan);outline-offset:1px}
.field-hint{font-size:13px;color:var(--muted);min-height:1em}
.field-hint.ok{color:var(--onyx);font-weight:700}
.field-hint.bad{color:var(--danger);font-weight:700}
.btn{appearance:none;border:0;border-radius:8px;min-height:52px;padding:12px 16px;font-family:var(--font-display);
  font-size:17px;font-weight:800;cursor:pointer;width:100%;text-align:center;text-decoration:none;
  display:flex;align-items:center;justify-content:center;gap:8px}
.btn:focus-visible{outline:3px solid var(--cyan);outline-offset:2px}
.btn-money{background:var(--mint);color:var(--onyx);border:2px solid var(--onyx)}
.btn-money:hover{background:var(--onyx);color:#FFFFFF}
.btn-dark{background:var(--onyx);color:#FFFFFF}
.btn-outline{background:var(--surface);color:var(--onyx);border:1px solid var(--onyx);min-height:48px;font-size:16px}
.btn-outline:hover{background:var(--well)}
.btn[disabled]{background:var(--well);color:var(--muted);border:1px solid var(--line);cursor:not-allowed}

/* Payout profile */
.rows{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding-bottom:8px}
.row span:first-child{color:var(--muted);font-size:14px}
.row span:last-child{color:var(--onyx);font-weight:700;text-align:right}

/* History */
.history{list-style:none;display:flex;flex-direction:column;gap:10px}
.history li{display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid var(--line);border-radius:10px;padding:12px}
.ref{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;color:var(--onyx);font-size:14px}
.amount{font-family:var(--font-display);font-weight:800;color:var(--onyx);font-size:17px}
.stack-end{display:flex;flex-direction:column;align-items:flex-end;gap:6px}

/* Storefront */
.vanity{display:flex;flex-direction:column;gap:10px}
.vanity-link{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px;font-weight:800;color:var(--onyx);word-break:break-all}
.items{list-style:none;display:flex;flex-direction:column;gap:12px}
.item{display:flex;flex-direction:column;gap:12px}
.item-head{display:flex;gap:12px;align-items:center}
.thumb{flex:none;width:64px;height:64px;border-radius:10px;object-fit:cover;border:1px solid var(--line);background:var(--berry);
  color:#FFFFFF;display:grid;place-items:center;font-family:var(--font-display);font-weight:800;font-size:22px}
.item.off{background:var(--well)}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
details{border:1px solid var(--line);border-radius:10px;background:var(--surface)}
summary{min-height:48px;display:flex;align-items:center;padding:0 14px;font-weight:800;color:var(--onyx);cursor:pointer}
summary:focus-visible{outline:3px solid var(--cyan)}
.hooks{list-style:none;display:flex;flex-direction:column;gap:10px;padding:0 14px 14px}
.angle{display:inline-flex;align-items:center;min-height:24px;padding:0 8px;border-radius:9999px;font-size:11px;font-weight:800;
  letter-spacing:.06em;text-transform:uppercase;background:var(--surface);color:var(--onyx);border:2px solid var(--onyx);margin-bottom:4px}
.angle-problema{border-color:var(--coral)}
.angle-prueba{border-color:var(--cyan)}
.angle-oferta{border-color:var(--amber)}
.hook-text{color:var(--onyx);font-weight:600}
.empty{text-align:center}

/* Bottom tab bar */
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:10;background:var(--surface);border-top:1px solid var(--line);
  display:flex;justify-content:center;padding-bottom:env(safe-area-inset-bottom)}
.tabbar-inner{display:grid;grid-template-columns:repeat(3,1fr);width:100%;max-width:560px}
.tab{min-height:64px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-decoration:none;
  color:var(--muted);font-size:13px;font-weight:700;border-top:3px solid transparent}
.tab-icon{font-size:20px;line-height:1}
.tab[aria-current="page"]{color:var(--onyx);border-top-color:var(--coral)}
.tab:focus-visible{outline:3px solid var(--cyan);outline-offset:-3px}

footer{color:var(--muted);font-size:12px;text-align:center;padding:0 16px 16px}
.brand-logo{display:block;flex:none}
`;

const SCRIPT = `
(function(){
  var cfg = JSON.parse(document.getElementById('portal-config').textContent);
${BUYER_CLIENT_KIT_JS}
  function copyText(text, button, fallbackEl){
    var label = button.getAttribute('data-label') || button.textContent;
    button.setAttribute('data-label', label);
    function done(ok){
      if (!ok && fallbackEl) selectNode(fallbackEl);
      button.textContent = ok ? '¡Copiado!' : 'Selecciona y copia';
      setTimeout(function(){ button.textContent = label; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function(){ done(true); }, function(){ done(legacyCopy(text)); });
    } else {
      done(legacyCopy(text));
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function(button){
    button.classList.remove('hidden');
    button.addEventListener('click', function(){
      var key = button.getAttribute('data-copy');
      var text = cfg.copies[key];
      if (typeof text === 'string') copyText(text, button, document.getElementById(button.getAttribute('data-copy-fallback') || ''));
    });
  });

  /* Live CLABE check (same Modulo-10 rule the server enforces). */
  var clabe = document.getElementById('clabe'), hint = document.getElementById('clabe-hint');
  if (clabe && hint) {
    clabe.addEventListener('input', function(){
      var digits = clabe.value.replace(/[^0-9]/g, '');
      hint.className = 'field-hint';
      if (digits.length < 18) { hint.textContent = digits.length + ' de 18 dígitos'; return; }
      if (digits.length > 18) { hint.textContent = 'La CLABE tiene 18 dígitos.'; hint.className = 'field-hint bad'; return; }
      var w = [3, 7, 1], sum = 0;
      for (var i = 0; i < 17; i++) sum += (Number(digits[i]) * w[i % 3]) % 10;
      var ok = (10 - (sum % 10)) % 10 === Number(digits[17]);
      hint.textContent = ok ? 'CLABE válida' : 'Revisa la CLABE: el dígito verificador no coincide.';
      hint.className = 'field-hint ' + (ok ? 'ok' : 'bad');
    });
  }
})();
`;

export function renderPortalNav(active: PortalTab | null): string {
  const tab = (id: PortalTab, href: string, icon: string, label: string) =>
    `<a class="tab" href="${href}"${active === id ? ' aria-current="page"' : ''}><span class="tab-icon" aria-hidden="true">${icon}</span>${label}</a>`;
  return `<nav class="tabbar" aria-label="Portal de creador"><div class="tabbar-inner">
  ${tab('storefront', '/c/storefront', '🛍️', 'Mi Vitrina')}
  ${tab('wallet', '/c/wallet', '💰', 'Mi Billetera')}
  ${tab('invitations', '/c/invitations', '📬', 'Invitaciones')}
</div></nav>`;
}

function flashHtml(flash: Flash | null): string {
  if (!flash) return '';
  return `<p class="flash flash-${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(flash.message)}</p>`;
}

export function renderPortalShell(opts: { title: string; nonce: string; active: PortalTab | null; body: string; copies?: Record<string, string> }): string {
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
<footer>Portal de creadores · Referrals</footer>
${opts.active ? renderPortalNav(opts.active) : ''}
<script type="application/json" id="portal-config">${safeJsonForHtml({ copies: opts.copies ?? {} })}</script>
<script nonce="${opts.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/** A copy button: hidden until the script runs (no dead buttons without JavaScript). */
const copyButton = (key: string, label: string, fallbackId: string, cls = 'btn btn-dark') =>
  `<button class="${cls} hidden" type="button" data-copy="${escapeHtml(key)}" data-copy-fallback="${escapeHtml(fallbackId)}">${label}</button>`;

// ---------- Mi Billetera ----------

export interface WalletView {
  creatorName: string;
  balance: BalanceDto;
  profile: PayoutProfileDto;
  withdrawals: WithdrawalDto[];
  flash: Flash | null;
  csrf: string;
  /** Fresh per render: a double-tapped submit reuses it, so only one withdrawal is created. */
  idempotencyKey: string;
}

function withdrawBlocker(view: WalletView): string | null {
  const { balance, profile } = view;
  if (!profile.payout_ready) return 'Registra tu cuenta CLABE para poder retirar.';
  if (profile.withdrawals_available_at) {
    return `Por seguridad, podrás retirar a partir del ${formatDateTime(profile.withdrawals_available_at)} (24 h después de registrar o cambiar tu CLABE).`;
  }
  if (balance.available_balance_cents < Number(MIN_WITHDRAWAL_CENTS)) {
    return `El retiro mínimo es de ${formatCents(Number(MIN_WITHDRAWAL_CENTS))}.`;
  }
  return null;
}

export function renderWalletPage(view: WalletView, opts: { nonce: string }): string {
  const { balance, profile } = view;
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">`;
  const blocker = withdrawBlocker(view);

  const profileCard = profile.clabe_masked
    ? `<section class="card" aria-labelledby="profile-title">
    <h2 id="profile-title">Cuenta para retiros (SPEI)</h2>
    <div class="rows">
      <div class="row"><span>Banco</span><span>${escapeHtml(profile.bank_name ?? 'Banco no identificado')}</span></div>
      <div class="row"><span>CLABE</span><span class="num">•••• ${escapeHtml(profile.clabe_masked.slice(-4))}</span></div>
      <div class="row"><span>Titular</span><span>${escapeHtml(profile.legal_name ?? '—')}</span></div>
    </div>
    <p class="muted">¿Necesitas cambiarla? Escríbenos a soporte; por seguridad no se cambia desde aquí.</p>
  </section>`
    : `<section class="card" aria-labelledby="profile-title">
    <h2 id="profile-title">Registra tu cuenta CLABE</h2>
    <p class="muted">Aquí recibirás tus retiros por SPEI. Usa una cuenta a tu nombre.</p>
    <form method="post" action="/c/wallet/payout-profile">
      ${csrf}
      <label for="clabe">CLABE interbancaria (18 dígitos)</label>
      <input id="clabe" name="clabe" type="text" inputmode="numeric" autocomplete="off" maxlength="24" required class="num" placeholder="002 010 07777777777 1" aria-describedby="clabe-hint">
      <p class="field-hint" id="clabe-hint" aria-live="polite"></p>
      <label for="legal_name">Nombre del titular (como aparece en tu banco)</label>
      <input id="legal_name" name="legal_name" type="text" autocomplete="name" minlength="3" maxlength="150" required>
      <label for="rfc">RFC (opcional)</label>
      <input id="rfc" name="rfc" type="text" autocomplete="off" maxlength="13">
      <button class="btn btn-dark" type="submit">Guardar cuenta</button>
      <p class="muted">Por seguridad, los retiros se habilitan 24 h después de registrar tu cuenta.</p>
    </form>
  </section>`;

  const history = view.withdrawals.length
    ? `<ul class="history">${view.withdrawals
        .map((w) => {
          const status = WITHDRAWAL_STATUS[w.status];
          return `
      <li>
        <div><span class="ref num">${withdrawalReference(w.id)}</span><p class="muted num">${escapeHtml(formatDate(w.requested_at))}</p></div>
        <div class="stack-end"><span class="amount num">${escapeHtml(formatCents(w.amount_cents))}</span><span class="pill ${status.cls}">${status.label}</span></div>
      </li>`;
        })
        .join('')}
    </ul>`
    : '<p class="muted">Aún no has hecho retiros.</p>';

  const body = `
<main>
  <h1>Mi Billetera</h1>
  ${flashHtml(view.flash)}
  <section class="balances" aria-label="Saldos">
    <div class="balance balance-available">
      <p class="balance-label">Disponible para retirar</p>
      <p class="balance-amount num" id="available">${escapeHtml(formatCents(balance.available_balance_cents))}</p>
    </div>
    <div class="balance balance-escrow">
      <p class="balance-label">En custodia</p>
      <p class="balance-amount num" id="escrow">${escapeHtml(formatCents(balance.pending_escrow_balance_cents))}</p>
    </div>
    <p class="note">Cada venta queda en custodia de 14 a 28 días según la categoría del producto, por si hay devoluciones. Al terminar, pasa a tu saldo disponible.${
      balance.is_negative ? ' Tu saldo es negativo por una devolución; se compensa con tus próximas ventas.' : ''
    }</p>
  </section>

  ${profileCard}

  <section class="card" aria-labelledby="withdraw-title">
    <h2 id="withdraw-title">Retirar</h2>
    <form method="post" action="/c/wallet/withdraw">
      ${csrf}
      <input type="hidden" name="idempotency_key" value="${escapeHtml(view.idempotencyKey)}">
      <button class="btn btn-money" type="submit"${blocker ? ' disabled' : ''}>Retirar fondos disponibles</button>
      <p class="muted">${blocker ? escapeHtml(blocker) : `Se transfiere todo tu saldo disponible por SPEI a tu cuenta •••• ${escapeHtml(profile.clabe_masked?.slice(-4) ?? '')}.`}</p>
    </form>
  </section>

  <section class="card" aria-labelledby="history-title">
    <h2 id="history-title">Historial de retiros</h2>
    ${history}
  </section>
</main>`;

  return renderPortalShell({ title: 'Mi Billetera | Referrals', nonce: opts.nonce, active: 'wallet', body });
}

// ---------- Mi Vitrina ----------

export interface StorefrontManageItem extends StorefrontItemDto {
  hooks: HookSet;
}

export interface StorefrontManageView {
  creatorName: string;
  /** Public bio link, e.g. https://referals.mx/@leo */
  vanityUrl: string;
  items: StorefrontManageItem[];
  flash: Flash | null;
  csrf: string;
}

export function renderStorefrontManagePage(view: StorefrontManageView, opts: { nonce: string }): string {
  const copies: Record<string, string> = { vanity: view.vanityUrl };
  const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">`;

  const cards = view.items
    .map((item, i) => {
      copies[`script-${i}`] = scriptFromHooks(item.product_name, item.hooks);
      const status = !item.is_active
        ? '<span class="pill pill-neutral">Oculto</span>'
        : item.is_live
          ? '<span class="pill pill-mint">Visible</span>'
          : '<span class="pill pill-amber">No disponible</span>';
      const hooks = item.hooks.hooks
        .map(
          (h) => `
          <li><span class="angle angle-${h.angle}">${ANGLE_LABELS[h.angle]}</span><p class="hook-text">“${escapeHtml(h.hook)}”</p><p class="muted">En pantalla: ${escapeHtml(h.on_screen_text)}</p></li>`,
        )
        .join('');
      return `
    <li class="card item${item.is_active ? '' : ' off'}">
      <div class="item-head">
        ${renderProductThumb(item.product_name, item.product_image_url, { className: 'thumb', size: 64 })}
        <div>
          <h3>${escapeHtml(item.product_name)}</h3>
          <div class="tags">${status}<span class="pill pill-cyan num">${formatRate(item.commission_rate)} comisión</span>${item.is_featured ? '<span class="pill pill-neutral">Destacado</span>' : ''}</div>
        </div>
      </div>
      <details>
        <summary>Ver mis 3 hooks de video</summary>
        <ol class="hooks" id="hooks-${i}">${hooks}
        </ol>
        <div class="hooks">${copyButton(`script-${i}`, 'Copiar guion', `hooks-${i}`, 'btn btn-outline')}</div>
      </details>
      <form method="post" action="/c/storefront/items/${encodeURIComponent(item.id)}/visibility">
        ${csrf}
        <input type="hidden" name="is_active" value="${item.is_active ? 'false' : 'true'}">
        <button class="btn ${item.is_active ? 'btn-outline' : 'btn-dark'}" type="submit">${item.is_active ? 'Ocultar de mi vitrina' : 'Mostrar en mi vitrina'}</button>
      </form>
    </li>`;
    })
    .join('');

  const body = `
<main>
  <h1>Mi Vitrina</h1>
  ${flashHtml(view.flash)}
  <section class="card vanity" aria-labelledby="vanity-title">
    <h2 id="vanity-title">Tu enlace de biografía</h2>
    <a class="vanity-link" id="vanity-link" href="${escapeHtml(view.vanityUrl)}">${escapeHtml(view.vanityUrl.replace(/^https?:\/\//, ''))}</a>
    ${copyButton('vanity', 'Copiar Enlace de Biografía', 'vanity-link')}
    <p class="muted">Ponlo en tu bio de Instagram y TikTok: ahí están todos tus productos con cupón.</p>
  </section>

  <h2>Productos en tu vitrina</h2>
  ${
    view.items.length
      ? `<ul class="items">${cards}
  </ul>`
      : '<section class="card empty"><p class="muted">Aún no tienes productos. Acepta una invitación para agregar el primero.</p><a class="btn btn-dark" href="/c/invitations">Ver invitaciones</a></section>'
  }
</main>`;

  return renderPortalShell({ title: 'Mi Vitrina | Referrals', nonce: opts.nonce, active: 'storefront', body, copies });
}

// ---------- Invitaciones ----------

export function renderInvitationsInboxPage(view: { invitations: CreatorInvitationDto[] }, opts: { nonce: string }): string {
  const order: Record<CreatorInvitationDto['status'], number> = { pending: 0, accepted: 1, declined: 2, expired: 3 };
  const sorted = [...view.invitations].sort((a, b) => order[a.status] - order[b.status]);
  const cards = sorted
    .map((inv) => {
      const status = INVITATION_STATUS[inv.status];
      return `
    <li class="card item">
      <div class="item-head">
        ${renderProductThumb(inv.product.name, inv.product.image_url, { className: 'thumb', size: 64 })}
        <div>
          <p class="muted">${escapeHtml(inv.brand.name)}</p>
          <h3>${escapeHtml(inv.product.name)}</h3>
          <div class="tags"><span class="pill ${status.cls}">${status.label}</span><span class="pill pill-mint num">${escapeHtml(formatPrice(inv.estimated_earnings_per_sale, inv.product.currency))} por venta</span></div>
        </div>
      </div>
      <a class="btn ${inv.status === 'pending' ? 'btn-dark' : 'btn-outline'}" href="/c/invitations/${encodeURIComponent(inv.id)}">${inv.status === 'pending' ? 'Ver invitación' : 'Ver detalles'}</a>
    </li>`;
    })
    .join('');

  const body = `
<main>
  <h1>Invitaciones</h1>
  ${
    sorted.length
      ? `<ul class="items">${cards}
  </ul>`
      : '<section class="card empty"><p class="muted">Aún no tienes invitaciones. Te avisaremos por WhatsApp cuando una marca te invite.</p></section>'
  }
</main>`;
  return renderPortalShell({ title: 'Invitaciones | Referrals', nonce: opts.nonce, active: 'invitations', body });
}

export function renderPortalSignedOutPage(opts: { nonce: string }): string {
  return renderPortalShell({
    title: 'Entra desde WhatsApp | Referrals',
    nonce: opts.nonce,
    active: null,
    body: `
<main><section class="card vanity"><h1>Abre tu portal desde WhatsApp</h1><p class="muted">Por seguridad, entra con un enlace que te enviamos por WhatsApp. Tu sesión dura 24 horas.</p><a class="btn btn-dark" href="/c/login">Recibir enlace de acceso</a></section></main>`,
  });
}
