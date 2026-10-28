import type { MatchTag } from '../matchmaker/matchmaker.service.js';
import type { InvitationQuotaDto } from '../matchmaker/invitations.service.js';
import { brandFaviconHref, escapeHtml, formatPrice, productInitials, renderBrandLogo, renderProductThumb, safeJsonForHtml } from '../links/landing-template.js';

/**
 * Seller dashboard (/seller/dashboard) and sign-in (/seller/login): desktop-first,
 * server-rendered, flat Solid Slate (no gradients) with inline CSS/JS under the
 * per-request CSP nonce. Every action is a plain form post that redirects back;
 * the script upgrades invitations to an inline fetch that updates the card and
 * the quota counters without a reload.
 *
 * Contrast (WCAG AAA): solid Cyan, Mint and Amber fills carry Onyx text; Berry
 * and Coral are used as borders/accents only (white on them is below 7:1).
 */

export interface Flash {
  kind: 'success' | 'error';
  message: string;
}

export const PENDING_LIMIT_MESSAGE = 'Límite de 25 invitaciones pendientes alcanzado';
export const DAILY_LIMIT_MESSAGE = 'Límite diario de 50 invitaciones alcanzado';

const TAG_LABELS: Record<MatchTag, string> = {
  niche_match: 'Nicho exacto',
  adjacent_audience: 'Audiencia afín',
  generalist: 'Generalista',
  high_engagement: 'Alto engagement',
  micro_sweet_spot: 'Micro ideal',
  macro_reach: 'Gran alcance',
  nano_audience: 'Nano audiencia',
  verified: 'Verificado',
  payout_ready: 'Cobro listo',
};

const CAMPAIGN_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: 'Activa', cls: 'pill-mint' },
  paused: { label: 'Pausada', cls: 'pill-amber' },
  ended: { label: 'Terminada', cls: 'pill-neutral' },
};

/** "0.1500" → "15%", "10.00" (percent) → "10%". */
export const formatRatePercent = (rate: string) => `${Number((Number(rate) * 100).toFixed(2))}%`;
const formatPercent = (percent: string) => `${Number(Number(percent).toFixed(2))}%`;
const formatCount = (n: number) => new Intl.NumberFormat('es-MX').format(n);
const compactFollowers = (n: number) =>
  new Intl.NumberFormat('es-MX', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

const STYLES = `
:root{
  --canvas:#F8FAFC;--surface:#FFFFFF;--well:#F1F5F9;--line:#E2E8F0;
  --onyx:#0F141C;--body:#334155;--muted:#475569;
  --coral:#FE2C55;--berry:#D62976;--cyan:#00B4D8;--mint:#10B981;--emerald:#059669;--amber:#F59E0B;--danger:#991B1B;
  --font:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--canvas);color:var(--body);line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh}
h1,h2,h3,strong{color:var(--onyx);letter-spacing:-.01em}
h1{font-size:26px;line-height:32px}
h2{font-size:18px;line-height:24px}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on}
.muted{color:var(--muted);font-size:14px}
.hidden{display:none}
a{color:var(--onyx)}
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--cyan);outline-offset:2px}

/* Top bar */
.topbar{background:var(--surface);border-bottom:1px solid var(--line)}
.topbar-inner{max-width:1280px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;color:var(--onyx)}
.store{display:flex;flex-direction:column;margin-right:auto}
.store-domain{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:var(--muted)}
.quota-badge{display:inline-flex;align-items:center;min-height:36px;padding:0 14px;border-radius:9999px;background:var(--amber);
  color:var(--onyx);font-weight:800;font-size:14px;border:1px solid var(--onyx)}
.quota-badge.full{background:var(--surface);color:var(--danger);border-color:var(--danger)}

/* Layout: 60 / 40 */
.layout{max-width:1280px;margin:0 auto;padding:24px;display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:24px;align-items:start}
@media (max-width:1023px){.layout{grid-template-columns:minmax(0,1fr)}}
.col{display:flex;flex-direction:column;gap:24px;min-width:0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}

/* Flash */
.flash{border-radius:10px;padding:12px 16px;font-weight:600;color:var(--onyx);border:2px solid var(--onyx);grid-column:1/-1}
.flash-success{background:var(--mint)}
.flash-error{background:var(--surface);border-color:var(--danger);color:var(--danger)}

/* KPI cards */
.kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
@media (min-width:1280px){.kpis{grid-template-columns:repeat(4,minmax(0,1fr))}}
.kpi{border-radius:12px;padding:16px;border:1px solid var(--line);background:var(--surface);display:flex;flex-direction:column;gap:6px;min-height:118px}
.kpi-label{font-size:13px;font-weight:700;color:var(--body)}
.kpi-value{font-size:28px;line-height:34px;font-weight:800;color:var(--onyx)}
.kpi-gmv{background:var(--mint);border-color:var(--onyx)}
.kpi-gmv .kpi-label{color:var(--onyx)}
.kpi-creators{border-top:6px solid var(--berry)}
.kpi-coupons{border-top:6px solid var(--coral)}
.kpi-slots{background:var(--amber);border-color:var(--onyx)}
.kpi-slots .kpi-label{color:var(--onyx)}

/* Pills */
.pill{display:inline-flex;align-items:center;min-height:26px;padding:0 10px;border-radius:9999px;font-size:12px;font-weight:800;
  letter-spacing:.03em;white-space:nowrap;color:var(--onyx);border:1px solid var(--onyx)}
.pill-mint{background:var(--mint)}
.pill-amber{background:var(--amber)}
.pill-neutral{background:var(--well);border-color:var(--line)}
.pill-outline{background:var(--surface)}

/* Campaigns table */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding:0 12px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:12px;border-bottom:1px solid var(--line);vertical-align:middle;color:var(--onyx)}
tr[aria-current="true"] td{background:var(--well)}
tr[aria-current="true"] td:first-child{box-shadow:inset 4px 0 0 var(--cyan)}
.product-cell{display:flex;align-items:center;gap:12px;min-width:200px;font-weight:700}
.thumb{flex:none;width:44px;height:44px;border-radius:8px;object-fit:cover;border:1px solid var(--line);background:var(--onyx);color:#FFFFFF;
  display:grid;place-items:center;font-weight:800;font-size:15px}
.link-btn{display:inline-flex;align-items:center;min-height:48px;padding:0 12px;font-weight:700;color:var(--onyx);border:1px solid var(--onyx);border-radius:8px;text-decoration:none;white-space:nowrap;background:var(--surface)}
.link-btn:hover{background:var(--well)}

/* Buttons & forms (48px+ targets) */
.btn{appearance:none;border:0;border-radius:8px;min-height:48px;padding:0 18px;font:inherit;font-size:15px;font-weight:800;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;white-space:nowrap}
.btn-dark{background:var(--onyx);color:#FFFFFF}
.btn-dark:hover{background:var(--body)}
.btn-cyan{background:var(--cyan);color:var(--onyx);border:2px solid var(--onyx);width:100%}
.btn-cyan:hover{background:var(--onyx);color:#FFFFFF}
.btn-outline{background:var(--surface);color:var(--onyx);border:1px solid var(--onyx)}
.btn[disabled]{background:var(--well);color:var(--muted);border:1px solid var(--line);cursor:not-allowed}
form{display:flex;flex-direction:column;gap:10px}
label{font-size:14px;font-weight:700;color:var(--onyx)}
input[type=text],input[type=password],input[type=number],select,textarea{width:100%;min-height:48px;font:inherit;font-size:16px;padding:10px 12px;
  border:1px solid var(--onyx);border-radius:8px;background:var(--surface);color:var(--onyx)}
textarea{min-height:88px;resize:vertical}
.check{display:flex;align-items:center;gap:10px;min-height:48px;font-weight:600}
.check input{width:22px;height:22px}
details.drawer>summary{list-style:none}
details.drawer>summary::-webkit-details-marker{display:none}
.launch-form{margin-top:16px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--canvas)}
.form-row{display:grid;grid-template-columns:2fr 1fr;gap:12px}

/* Visual Matchmaker */
.matchmaker{position:sticky;top:16px}
.matchmaker-head{display:flex;flex-direction:column;gap:4px;margin-bottom:16px}
.eyebrow{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--onyx);display:inline-flex;align-items:center;gap:8px}
.eyebrow::before{content:"";width:10px;height:10px;border-radius:2px;background:var(--cyan);border:1px solid var(--onyx)}
.matches{list-style:none;display:flex;flex-direction:column;gap:12px}
.match{border:1px solid var(--line);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;background:var(--surface)}
.match-head{display:flex;gap:12px;align-items:center}
.avatar{flex:none;width:52px;height:52px;border-radius:9999px;object-fit:cover;border:2px solid var(--onyx);background:var(--onyx);color:#FFFFFF;
  display:grid;place-items:center;font-weight:800;font-size:17px}
.who{min-width:0;flex:1}
.who strong{display:block;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.handles{display:flex;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--body)}
.handle-ig{border-bottom:2px solid var(--berry)}
.handle-tt{border-bottom:2px solid var(--coral)}
.score{flex:none;display:inline-flex;align-items:center;min-height:32px;padding:0 12px;border-radius:9999px;background:var(--cyan);
  color:var(--onyx);font-weight:800;font-size:14px;border:1px solid var(--onyx)}
.tags{list-style:none;display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:12px;font-weight:700;color:var(--onyx);background:var(--well);border:1px solid var(--line);border-radius:6px;padding:3px 8px}
.stats{display:flex;justify-content:space-between;gap:8px;font-size:13px;color:var(--body)}
.payout{font-weight:800;color:var(--onyx)}
.payout-amount{background:var(--mint);border-radius:6px;padding:1px 6px;border:1px solid var(--onyx)}
.note-drawer{border:1px solid var(--line);border-radius:8px}
.note-drawer>summary{min-height:48px;display:flex;align-items:center;padding:0 12px;font-size:14px;font-weight:700;color:var(--onyx);cursor:pointer}
.note-drawer[open]>summary{border-bottom:1px solid var(--line)}
.note-body{padding:12px;display:flex;flex-direction:column;gap:8px}
.state{min-height:48px;display:flex;align-items:center;justify-content:center;border-radius:8px;font-weight:800;font-size:15px;color:var(--onyx);border:1px solid var(--onyx)}
.state-pending{background:var(--amber)}
.state-joined{background:var(--mint)}
.state-closed{background:var(--well);border-color:var(--line);color:var(--body)}
.limit-hint{font-size:13px;font-weight:700;color:var(--danger)}
.inline-error{font-size:13px;font-weight:700;color:var(--danger)}
.empty{text-align:center;padding:24px 8px}

/* Sign-in */
.auth{max-width:440px;margin:48px auto;padding:0 16px;display:flex;flex-direction:column;gap:16px}
.auth .card{display:flex;flex-direction:column;gap:12px}
details.operator>summary{min-height:48px;display:flex;align-items:center;font-weight:700;color:var(--onyx);cursor:pointer}
footer{max-width:1280px;margin:0 auto;padding:8px 24px 32px;color:var(--muted);font-size:12px}
`;

/** Progressive enhancement: inline invites (fetch → card + counters update). Plain forms work without it. */
const SCRIPT = `
(function(){
  var cfg = JSON.parse(document.getElementById('seller-config').textContent);
  var ERRORS = cfg.errors;
  function daysLeft(iso){
    var ms = new Date(iso).getTime() - Date.now();
    return Math.max(1, Math.ceil(ms / 86400000));
  }
  function applyQuota(q){
    if (!q) return;
    var available = Math.max(0, q.max_pending - q.active_pending);
    Array.prototype.forEach.call(document.querySelectorAll('[data-slots]'), function(el){
      el.textContent = el.getAttribute('data-slots') === 'badge'
        ? available + ' / ' + q.max_pending + ' Slots Activos'
        : available + ' / ' + q.max_pending;
    });
    var badge = document.getElementById('quota-badge');
    if (badge) badge.classList.toggle('full', available === 0);
    if (!q.can_invite) {
      var reason = q.active_pending >= q.max_pending ? cfg.pendingLimit : cfg.dailyLimit;
      Array.prototype.forEach.call(document.querySelectorAll('.invite-form button[type=submit]'), function(b){
        b.disabled = true;
        b.parentNode.setAttribute('title', reason);
        b.title = reason;
      });
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('.invite-form'), function(form){
    form.addEventListener('submit', function(ev){
      if (!window.fetch) return;
      ev.preventDefault();
      var button = form.querySelector('button[type=submit]');
      var error = form.querySelector('.inline-error');
      if (button.disabled) return;
      button.disabled = true;
      var label = button.textContent;
      button.textContent = 'Enviando…';
      error.textContent = '';
      var data = {};
      Array.prototype.forEach.call(form.elements, function(el){ if (el.name) data[el.name] = el.value; });
      fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(data)
      }).then(function(res){
        return res.json().catch(function(){ return {}; }).then(function(body){ return { ok: res.ok, body: body }; });
      }).then(function(r){
        if (r.ok) {
          var state = document.createElement('p');
          state.className = 'state state-pending num';
          state.setAttribute('role', 'status');
          state.textContent = 'Invitado (Expira en ' + daysLeft(r.body.expires_at) + 'd)';
          form.parentNode.replaceChild(state, form);
          applyQuota(r.body.quota);
          return;
        }
        var code = r.body && r.body.error && r.body.error.code;
        error.textContent = ERRORS[code] || ERRORS.DEFAULT;
        if (r.body && r.body.error && r.body.error.details && r.body.error.details.quota) applyQuota(r.body.error.details.quota);
        button.disabled = !!(r.body && r.body.error && r.body.error.details && r.body.error.details.quota && !r.body.error.details.quota.can_invite);
        button.textContent = label;
      }).catch(function(){
        error.textContent = ERRORS.DEFAULT;
        button.disabled = false;
        button.textContent = label;
      });
    });
  });
})();
`;

/** Messages the inline script may show for an invite error code (never server text). */
export const INVITE_ERROR_MESSAGES: Record<string, string> = {
  INVITATION_PENDING_LIMIT_REACHED: PENDING_LIMIT_MESSAGE,
  DAILY_INVITATION_QUOTA_EXCEEDED: DAILY_LIMIT_MESSAGE,
  INVITATION_PENDING: 'Este creador ya tiene una invitación pendiente.',
  INVITATION_DECLINED: 'Este creador declinó esta campaña.',
  ALREADY_JOINED: 'Este creador ya promociona esta campaña.',
  CREATOR_SUSPENDED: 'Este creador no está aceptando campañas.',
  CAMPAIGN_NOT_ACTIVE: 'La campaña o el producto no están activos.',
  CSRF_TOKEN_INVALID: 'La página expiró. Recárgala e inténtalo de nuevo.',
  SESSION_EXPIRED: 'Tu sesión expiró. Vuelve a iniciar sesión.',
  DEFAULT: 'No pudimos enviar la invitación. Inténtalo de nuevo.',
};

function shell(opts: { title: string; nonce: string; body: string; config?: Record<string, unknown> }): string {
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(opts.title)}</title>
<link rel="icon" type="image/svg+xml" href="${brandFaviconHref()}">
<style nonce="${opts.nonce}">${STYLES}</style>
</head>
<body>
${opts.body}
${
  opts.config
    ? `<script type="application/json" id="seller-config">${safeJsonForHtml(opts.config)}</script>
<script nonce="${opts.nonce}">${SCRIPT}</script>`
    : ''
}
</body>
</html>`;
}

function flashHtml(flash: Flash | null): string {
  if (!flash) return '';
  return `<p class="flash flash-${flash.kind}" role="${flash.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(flash.message)}</p>`;
}

// ---------- Sign-in ----------

export function renderSellerLoginPage(view: { csrf: string; error?: string | null; adminEnabled: boolean }, opts: { nonce: string }): string {
  const error = view.error ? `<p class="flash flash-error" role="alert">${escapeHtml(view.error)}</p>` : '';
  const operator = view.adminEnabled
    ? `
  <section class="card">
    <details class="operator">
      <summary>Acceso de operador Referrals</summary>
      <form method="post" action="/seller/login">
        <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
        <label for="admin_token">Token de administrador</label>
        <input type="password" id="admin_token" name="admin_token" autocomplete="off" required>
        <label for="seller_id">ID de la tienda</label>
        <input type="text" id="seller_id" name="seller_id" autocomplete="off" spellcheck="false" required>
        <button class="btn btn-outline" type="submit">Entrar como operador</button>
      </form>
    </details>
  </section>`
    : '';
  return shell({
    title: 'Entrar | Referrals para marcas',
    nonce: opts.nonce,
    body: `
<main class="auth">
  <div class="brand">${renderBrandLogo({ size: 32 })}Referrals para marcas</div>
  ${error}
  <section class="card">
    <h1>Entra a tu panel</h1>
    <p class="muted">Usa la API key de tu tienda (empieza con <code>ref_live_</code>). Tu sesión dura 12 horas.</p>
    <form method="post" action="/seller/login">
      <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
      <label for="api_key">API key</label>
      <input type="password" id="api_key" name="api_key" autocomplete="off" spellcheck="false" required>
      <button class="btn btn-dark" type="submit">Entrar al panel</button>
    </form>
  </section>${operator}
</main>`,
  });
}

// ---------- Dashboard ----------

export interface DashboardCampaignRow {
  id: string;
  productName: string;
  productImageUrl: string | null;
  commissionRate: string;
  status: string;
  isPublicCatalog: boolean;
}

export type MatchState = 'invitable' | 'pending' | 'joined' | 'declined';

export interface MatchCard {
  slug: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  instagramHandle: string | null;
  tiktokHandle: string | null;
  score: number;
  tags: MatchTag[];
  followers: number;
  engagementRate: string;
  state: MatchState;
  /** For pending invitations. */
  expiresAt: string | null;
  /** True when the last invitation expired (the button re-sends). */
  resend: boolean;
}

export interface DashboardView {
  seller: { name: string; storeDomain: string | null; buyerDiscountPercent: string | null };
  kpis: { gmv: string; activeCreators: number; redeemedCoupons: number };
  campaigns: DashboardCampaignRow[];
  /** The campaign the matchmaker is showing (null: no campaign yet). */
  selected: { id: string; productName: string; currency: string; estimatedPayout: string; quota: InvitationQuotaDto; canInvite: boolean } | null;
  matches: MatchCard[];
  products: { id: string; name: string }[];
  flash: Flash | null;
  csrf: string;
  now: Date;
}

const daysUntil = (iso: string, now: Date) => Math.max(1, Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000));

function renderAvatar(card: MatchCard): string {
  if (card.avatarUrl && /^https:\/\//i.test(card.avatarUrl)) {
    return `<img class="avatar" src="${escapeHtml(card.avatarUrl)}" alt="" width="52" height="52" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  }
  return `<div class="avatar" aria-hidden="true">${escapeHtml(productInitials(card.name))}</div>`;
}

function limitReason(quota: InvitationQuotaDto): string | null {
  if (quota.active_pending >= quota.max_pending) return PENDING_LIMIT_MESSAGE;
  if (quota.sent_last_24h >= quota.daily_limit) return DAILY_LIMIT_MESSAGE;
  return null;
}

function renderMatchAction(card: MatchCard, view: DashboardView): string {
  const selected = view.selected!;
  if (card.state === 'pending' && card.expiresAt) {
    return `<p class="state state-pending num" role="status">Invitado (Expira en ${daysUntil(card.expiresAt, view.now)}d)</p>`;
  }
  if (card.state === 'joined') return '<p class="state state-joined">✓ Ya promociona esta campaña</p>';
  if (card.state === 'declined') return '<p class="state state-closed">Declinó esta campaña</p>';

  const reason = selected.canInvite ? limitReason(selected.quota) : 'La campaña o el producto no están activos.';
  const label = card.resend ? 'Reenviar invitación' : 'Invitar a Campaña';
  const button = reason
    ? `<span title="${escapeHtml(reason)}"><button class="btn btn-cyan" type="submit" disabled title="${escapeHtml(reason)}">${label}</button></span>
       <p class="limit-hint">${escapeHtml(reason)}</p>`
    : `<button class="btn btn-cyan" type="submit">${label}</button>`;
  return `<form class="invite-form" method="post" action="/seller/dashboard/invite">
      <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
      <input type="hidden" name="campaign_id" value="${escapeHtml(selected.id)}">
      <input type="hidden" name="creator_slug" value="${escapeHtml(card.slug)}">
      <details class="note-drawer">
        <summary>✎ Agregar nota personal (opcional)</summary>
        <div class="note-body">
          <label for="note-${escapeHtml(card.slug)}">Nota para ${escapeHtml(card.name)}</label>
          <textarea id="note-${escapeHtml(card.slug)}" name="custom_note" maxlength="500" placeholder="¡Nos encantó tu contenido!"></textarea>
        </div>
      </details>
      ${button}
      <p class="inline-error" role="alert"></p>
    </form>`;
}

function renderMatchCard(card: MatchCard, view: DashboardView): string {
  const handles = [
    card.instagramHandle ? `<span class="handle-ig" title="Instagram">IG ${escapeHtml(card.instagramHandle)}</span>` : '',
    card.tiktokHandle ? `<span class="handle-tt" title="TikTok">TT ${escapeHtml(card.tiktokHandle)}</span>` : '',
  ].join('');
  return `<li class="match" id="match-${escapeHtml(card.slug)}" data-creator="${escapeHtml(card.slug)}" data-state="${card.state}">
    <div class="match-head">
      ${renderAvatar(card)}
      <div class="who"><strong>${escapeHtml(card.name)}</strong><div class="handles">${handles || `<span>${escapeHtml(card.handle)}</span>`}</div></div>
      <span class="score num">${card.score}% Match</span>
    </div>
    <ul class="tags">${card.tags.map((t) => `<li class="tag" data-tag="${t}">${TAG_LABELS[t]}</li>`).join('')}</ul>
    <div class="stats num">
      <span>${escapeHtml(compactFollowers(card.followers))} seguidores · ${escapeHtml(formatRatePercent(card.engagementRate))} engagement</span>
    </div>
    <p class="payout">Pago estimado por venta: <span class="payout-amount num">${escapeHtml(formatPrice(view.selected!.estimatedPayout, view.selected!.currency))}</span></p>
    ${renderMatchAction(card, view)}
  </li>`;
}

function renderCampaigns(view: DashboardView): string {
  const discount = view.seller.buyerDiscountPercent ? formatPercent(view.seller.buyerDiscountPercent) : '—';
  const rows = view.campaigns
    .map((c) => {
      const status = CAMPAIGN_STATUS[c.status] ?? CAMPAIGN_STATUS.ended!;
      const current = view.selected?.id === c.id;
      return `<tr${current ? ' aria-current="true"' : ''} data-campaign="${escapeHtml(c.id)}">
        <td><div class="product-cell">${renderProductThumb(c.productName, c.productImageUrl, { className: 'thumb', size: 44 })}<span>${escapeHtml(c.productName)}</span></div></td>
        <td class="num">${escapeHtml(formatRatePercent(c.commissionRate))}</td>
        <td class="num">${escapeHtml(discount)}</td>
        <td>${c.isPublicCatalog ? '<span class="pill pill-mint">Público</span>' : '<span class="pill pill-outline">Privado</span>'}</td>
        <td><span class="pill ${status.cls}">${status.label}</span></td>
        <td>${current ? '<span class="pill pill-outline">Viendo matches</span>' : `<a class="link-btn" href="/seller/dashboard?campaign=${encodeURIComponent(c.id)}">Ver matches</a>`}</td>
      </tr>`;
    })
    .join('');

  const productOptions = view.products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  const launchForm = view.products.length
    ? `<form class="launch-form" method="post" action="/seller/dashboard/campaigns">
        <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
        <div class="form-row">
          <div><label for="product_id">Producto</label><select id="product_id" name="product_id" required>${productOptions}</select></div>
          <div><label for="commission_percent">Comisión (%)</label><input class="num" type="number" id="commission_percent" name="commission_percent" min="1" max="100" step="0.5" value="15" required></div>
        </div>
        <label class="check"><input type="checkbox" name="is_public_catalog" value="true"> Publicar en el Catálogo Abierto de creadores</label>
        <button class="btn btn-dark" type="submit">Lanzar campaña</button>
      </form>`
    : '<p class="launch-form muted">Primero registra un producto activo con la API de catálogo (<code>POST /v1/products</code>).</p>';

  return `<section class="card" aria-labelledby="campaigns-title">
    <div class="section-head">
      <h2 id="campaigns-title">Campañas activas</h2>
    </div>
    <details class="drawer">
      <summary class="btn btn-dark">+ Lanzar nueva campaña</summary>
      ${launchForm}
    </details>
    ${
      view.campaigns.length
        ? `<div class="table-wrap"><table>
      <thead><tr><th scope="col">Producto</th><th scope="col">Comisión</th><th scope="col">Descuento comprador</th><th scope="col">Catálogo</th><th scope="col">Estado</th><th scope="col"><span class="hidden">Acción</span></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
        : '<p class="empty muted">Aún no tienes campañas. Lanza la primera para ver a tus creadores recomendados.</p>'
    }
  </section>`;
}

function renderMatchmaker(view: DashboardView): string {
  if (!view.selected) {
    return `<aside class="card matchmaker" aria-labelledby="matchmaker-title">
      <div class="matchmaker-head"><span class="eyebrow">Visual Matchmaker</span><h2 id="matchmaker-title">Creadores recomendados</h2></div>
      <p class="empty muted">Lanza una campaña activa para ver a los creadores que mejor encajan con tu producto.</p>
    </aside>`;
  }
  const cards = view.matches.map((m) => renderMatchCard(m, view)).join('');
  return `<aside class="card matchmaker" aria-labelledby="matchmaker-title">
    <div class="matchmaker-head">
      <span class="eyebrow">Visual Matchmaker · IA</span>
      <h2 id="matchmaker-title">Creadores recomendados para ${escapeHtml(view.selected.productName)}</h2>
      <p class="muted">Ordenados por afinidad de nicho, engagement y alcance.</p>
    </div>
    ${cards ? `<ul class="matches">${cards}</ul>` : '<p class="empty muted">No hay creadores disponibles por ahora.</p>'}
  </aside>`;
}

export function renderSellerDashboardPage(view: DashboardView, opts: { nonce: string }): string {
  const quota = view.selected?.quota ?? null;
  const available = quota ? Math.max(0, quota.max_pending - quota.active_pending) : null;
  const max = quota?.max_pending ?? 25;
  const badge =
    available === null
      ? ''
      : `<span class="quota-badge num${available === 0 ? ' full' : ''}" id="quota-badge" data-slots="badge">${available} / ${max} Slots Activos</span>`;

  const body = `
<header class="topbar"><div class="topbar-inner">
  <div class="brand">${renderBrandLogo({ size: 28 })}</div>
  <div class="store"><strong>${escapeHtml(view.seller.name)}</strong><span class="store-domain">${escapeHtml(view.seller.storeDomain ?? 'Tienda sin dominio conectado')}</span></div>
  ${badge}
  <form method="post" action="/seller/logout"><input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}"><button class="btn btn-outline" type="submit">Salir</button></form>
</div></header>
<main class="layout">
  ${flashHtml(view.flash)}
  <div class="col">
    <section class="kpis" aria-label="Resultados">
      <div class="kpi kpi-gmv"><span class="kpi-label">GMV generado</span><span class="kpi-value num" id="kpi-gmv">${escapeHtml(formatPrice(view.kpis.gmv, 'MXN'))}</span></div>
      <div class="kpi kpi-creators"><span class="kpi-label">Creadores activos</span><span class="kpi-value num" id="kpi-creators">${formatCount(view.kpis.activeCreators)}</span></div>
      <div class="kpi kpi-coupons"><span class="kpi-label">Cupones canjeados</span><span class="kpi-value num" id="kpi-coupons">${formatCount(view.kpis.redeemedCoupons)}</span></div>
      <div class="kpi kpi-slots"><span class="kpi-label">Slots de invitación disponibles</span><span class="kpi-value num" id="kpi-slots"${available === null ? '' : ' data-slots="kpi"'}>${available === null ? '—' : `${available} / ${max}`}</span></div>
    </section>
    ${renderCampaigns(view)}
  </div>
  <div class="col">${renderMatchmaker(view)}</div>
</main>
<footer>Referrals para marcas · Pagos a creadores con custodia por categoría</footer>`;

  return shell({
    title: `${view.seller.name} | Panel Referrals`,
    nonce: opts.nonce,
    body,
    config: { errors: INVITE_ERROR_MESSAGES, pendingLimit: PENDING_LIMIT_MESSAGE, dailyLimit: DAILY_LIMIT_MESSAGE },
  });
}
