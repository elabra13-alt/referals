import {
  BUYER_CLIENT_KIT_JS,
  brandFaviconHref,
  escapeHtml,
  formatPrice,
  renderBrandLogo,
  renderProductThumb,
  safeJsonForHtml,
} from '../links/landing-template.js';
import type { StorefrontDto } from './storefront.schemas.js';

/**
 * Public creator storefront (/c/:slug, /@:slug): server-rendered, mobile-first,
 * flat "Kinetic Commercial Nexus" design (no gradients/shadows/blur), inline
 * CSS/JS under the per-request CSP nonce. Every product card links to its
 * /r/<link_slug> landing page, so the page works without JavaScript; with JS,
 * the coupon is requested inline and shown instantly.
 */

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

function initials(name: string): string {
  const parts = name.replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'R';
}

const bare = (handle: string) => handle.replace(/^@/, '');

const STYLES = `
:root{
  --canvas:#F8FAFC;--surface:#FFFFFF;--well:#F1F5F9;--line:#E2E8F0;
  --onyx:#0F141C;--body:#334155;--muted:#64748B;
  --coral:#FE2C55;--coral-hover:#E02449;--coral-active:#C81E3F;
  --berry:#D62976;--cyan:#00B4D8;--mint:#10B981;--amber:#F59E0B;--danger:#991B1B;
  --font-display:'Plus Jakarta Sans',Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --font-body:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--font-body);background:var(--canvas);color:var(--body);line-height:1.5;min-height:100vh;
  display:flex;flex-direction:column;align-items:center;-webkit-font-smoothing:antialiased}
h1,h2,h3,strong{font-family:var(--font-display);color:var(--onyx)}
a{color:inherit}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" on}
.top{width:100%;background:var(--surface);border-bottom:1px solid var(--line);padding:10px 16px;
  display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-weight:800;color:var(--onyx)}
main{width:100%;max-width:560px;padding:16px 16px 32px;display:flex;flex-direction:column;gap:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px}
.hidden{display:none}

/* Creator profile */
.profile{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:24px 16px}
.avatar{width:88px;height:88px;border-radius:50%;background:var(--berry);color:#FFFFFF;display:grid;place-items:center;
  font-family:var(--font-display);font-weight:800;font-size:30px;border:2px solid var(--onyx);object-fit:cover}
h1{font-size:24px;line-height:30px;letter-spacing:-.015em}
.name-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center}
.handle{color:var(--muted);font-size:14px;font-weight:600}
.bio{color:var(--body);font-size:15px;max-width:420px}
.socials{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}
.social{display:inline-flex;align-items:center;min-height:48px;padding:0 16px;border-radius:9999px;font-weight:700;
  font-size:14px;text-decoration:none;color:#FFFFFF}
.social-ig{background:var(--berry)}
.social-tt{background:var(--onyx)}
.social:focus-visible{outline:3px solid var(--coral);outline-offset:2px}

/* Pills */
.pill{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:9999px;font-size:11px;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.pill-verified{background:var(--cyan);color:var(--onyx)}
.pill-featured{background:var(--onyx);color:#FFFFFF}
.pill-cat{background:var(--well);color:var(--onyx);border:1px solid var(--line)}
.pill-mint{background:var(--mint);color:var(--onyx)}

/* Products */
.section-title{font-size:18px;line-height:24px}
.products{list-style:none;display:flex;flex-direction:column;gap:12px}
.product{display:flex;flex-direction:column;gap:8px}
.product.featured{border:2px solid var(--onyx)}
/* Square photo, or a solid Berry initials badge when the product has none */
.product-photo{display:grid;place-items:center;width:100%;height:auto;aspect-ratio:1/1;object-fit:cover;border-radius:8px;
  border:1px solid var(--line);background:var(--berry);color:#FFFFFF;font-family:var(--font-display);font-weight:800;font-size:40px}
.product-tags{display:flex;gap:6px;flex-wrap:wrap}
.product h3{font-size:18px;line-height:24px;letter-spacing:-.005em}
.price{font-family:var(--font-display);font-size:26px;line-height:30px;font-weight:800;color:var(--onyx);letter-spacing:-.02em}
.hook{color:var(--body);font-size:15px;border-left:3px solid var(--coral);padding-left:10px}
.empty{text-align:center;color:var(--muted)}

/* Primary action: solid Coral, white label at large-text size */
.btn{appearance:none;border:0;border-radius:8px;min-height:52px;padding:12px 16px;font-family:var(--font-display);
  font-size:19px;font-weight:800;cursor:pointer;width:100%;background:var(--coral);color:#FFFFFF;text-align:center;
  text-decoration:none;display:flex;align-items:center;justify-content:center}
.btn:hover{background:var(--coral-hover)}
.btn:active{background:var(--coral-active)}
.btn:focus-visible{outline:3px solid var(--onyx);outline-offset:2px}
.btn:disabled{background:var(--muted);cursor:wait}

/* Request + result panels */
.panel h2{font-size:18px;line-height:24px;margin-bottom:4px}
.muted{color:var(--muted);font-size:14px}
form{display:flex;flex-direction:column;gap:12px;margin-top:8px}
label{font-size:14px;font-weight:600;color:var(--onyx)}
input[type=email],input[type=tel]{width:100%;height:48px;font-size:16px;padding:0 14px;border:1px solid var(--line);
  border-radius:8px;background:var(--surface);color:var(--onyx)}
input::placeholder{color:var(--muted)}
input[type=email]:focus,input[type=tel]:focus{outline:1px solid var(--coral);outline-offset:0;border-color:var(--coral)}
.check{display:flex;gap:10px;align-items:center;font-weight:500;color:var(--body);min-height:48px}
input[type=checkbox]{width:20px;height:20px;accent-color:var(--coral);flex:none}
.error{color:var(--danger);font-size:14px;font-weight:600;min-height:1em}
.result-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.code-box{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);
  border:2px solid var(--onyx);border-radius:12px;padding:14px 14px 14px 16px;margin:8px 0 12px}
.code-label{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.code{display:block;font-family:var(--mono);font-size:26px;font-weight:800;letter-spacing:.04em;color:var(--onyx);white-space:nowrap}
.copy{flex:none;min-height:48px;min-width:96px;border:1px solid var(--onyx);border-radius:8px;background:var(--surface);
  color:var(--onyx);padding:0 14px;font-size:15px;font-weight:700;cursor:pointer}
.copy:hover,.copy:active{background:var(--onyx);color:#FFFFFF}
.expiry{display:flex;align-items:center;gap:8px;font-size:14px;margin-bottom:16px}
.panel .btn + .muted{margin-top:10px}
.timer{display:inline-flex;align-items:center;height:28px;padding:0 10px;border-radius:9999px;background:var(--amber);
  color:var(--onyx);font-weight:800;font-size:14px}

footer{color:var(--muted);font-size:12px;text-align:center;padding:0 16px 24px}
.powered{display:inline-flex;align-items:center;gap:6px}
.brand-logo{display:block;flex:none}
@media (max-width:430px){
  .code-box{flex-direction:column;align-items:stretch}
  .copy{width:100%}
}
`;

const SCRIPT = `
(function(){
  var cfg = JSON.parse(document.getElementById('sf-config').textContent);
  var $ = function(id){ return document.getElementById(id); };
${BUYER_CLIENT_KIT_JS}
  var request = $('sf-request'), result = $('sf-result'), form = $('sf-form'), btn = $('sf-submit'), err = $('sf-error');
  var phone = $('sf-phone'), wa = $('sf-wa'), go = $('sf-go'), copyBtn = $('sf-copy');
  var selected = -1, current = null;

  phone.addEventListener('input', function(){ wa.disabled = !phone.value.trim(); if (wa.disabled) wa.checked = false; });

  /* Each card links to /r/<slug> (no-JS fallback); with JS the coupon is requested inline. */
  cfg.items.forEach(function(item, i){
    $('sf-pick-' + i).addEventListener('click', function(e){
      e.preventDefault();
      selected = i;
      $('sf-selected-name').textContent = item.name;
      err.textContent = '';
      result.classList.add('hidden');
      request.classList.remove('hidden');
      if (request.scrollIntoView) request.scrollIntoView({ block: 'start' });
      $('sf-email').focus();
    });
  });

  /* Bound once; they act on whichever coupon is currently shown. */
  copyBtn.addEventListener('click', function(){ if (current) copyWithFeedback(current.code, copyBtn, $('sf-code')); });
  go.addEventListener('click', function(e){
    e.preventDefault();
    var href = go.getAttribute('href');
    if (!current || !href || href === '#') return;
    copyWithFeedback(current.code, null, $('sf-code')).then(function(){ window.location.assign(href); });
  });

  function showCode(data){
    current = data;
    $('sf-code').textContent = data.code;
    /* Only ever navigate to http(s) URLs. */
    go.setAttribute('href', /^https?:\\/\\//i.test(data.auto_apply_url) ? data.auto_apply_url : '#');
    startCountdown($('sf-timer'), data.expires_at);
    request.classList.add('hidden');
    result.classList.remove('hidden');
    $('sf-code').focus();
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if (selected < 0) return;
    err.textContent = '';
    var email = $('sf-email').value.trim() || null;
    var tel = normalizePhone(phone.value);
    if (!email && !tel) { err.textContent = 'Escribe tu correo o tu WhatsApp.'; return; }
    btn.disabled = true; btn.textContent = 'Generando…';
    fetch(cfg.couponPath + encodeURIComponent(cfg.items[selected].productId) + '/coupons', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        buyer: { email: email, phone: tel, send_whatsapp_backup: !!(tel && wa.checked) },
        client_context: { user_agent: navigator.userAgent }
      })
    }).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(body){ return { status: res.status, body: body }; });
    }).then(function(r){
      if (r.status === 201) return showCode(r.body);
      if (r.status === 409 && r.body.existing_code) return showCode(r.body.existing_code);
      var code = r.body && r.body.error && r.body.error.code;
      err.textContent = ERROR_MESSAGES[code] || 'No pudimos generar tu código. Intenta de nuevo.';
    }).catch(function(){
      err.textContent = 'Sin conexión. Revisa tu internet e intenta de nuevo.';
    }).then(function(){
      btn.disabled = false; btn.textContent = 'Obtener mi cupón';
    });
  });
})();
`;

function shell(opts: { title: string; description?: string; nonce: string; body: string }): string {
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#FFFFFF">
<title>${escapeHtml(opts.title)}</title>
${opts.description ? `<meta name="description" content="${escapeHtml(opts.description)}">` : ''}
<link rel="icon" type="image/svg+xml" href="${brandFaviconHref()}">
<style nonce="${opts.nonce}">${STYLES}</style>
</head>
<body>
<header class="top">${renderBrandLogo({ size: 24 })}Referrals</header>
${opts.body}
<footer><span class="powered">${renderBrandLogo({ size: 16 })}Cupones de un solo uso · Powered by Referrals</span></footer>
</body>
</html>`;
}

export function renderStorefrontPage(storefront: StorefrontDto, opts: { nonce: string }): string {
  const { creator, products } = storefront;
  const name = escapeHtml(creator.name);

  const avatar =
    creator.avatar_url && /^https:\/\//i.test(creator.avatar_url)
      ? `<img class="avatar" src="${escapeHtml(creator.avatar_url)}" alt="" width="88" height="88" referrerpolicy="no-referrer">`
      : `<div class="avatar" aria-hidden="true">${escapeHtml(initials(creator.name))}</div>`;

  const socials = [
    creator.instagram_handle
      ? `<a class="social social-ig" href="https://www.instagram.com/${encodeURIComponent(bare(creator.instagram_handle))}" rel="noopener noreferrer" target="_blank">Instagram</a>`
      : '',
    creator.tiktok_handle
      ? `<a class="social social-tt" href="https://www.tiktok.com/@${encodeURIComponent(bare(creator.tiktok_handle))}" rel="noopener noreferrer" target="_blank">TikTok</a>`
      : '',
  ].join('');

  const cards = products
    .map(
      (p, i) => `
    <li class="card product${p.is_featured ? ' featured' : ''}">
      ${renderProductThumb(p.name, p.image_url, { className: 'product-photo', size: 528 })}
      <div class="product-tags">${p.is_featured ? '<span class="pill pill-featured">Destacado</span>' : ''}<span class="pill pill-cat">${escapeHtml(categoryLabel(p.category))}</span></div>
      <h3>${escapeHtml(p.name)}</h3>
      <p class="price num">${escapeHtml(formatPrice(p.price, p.currency))}</p>
      ${p.hook ? `<p class="hook">${escapeHtml(p.hook)}</p>` : ''}
      <a class="btn" id="sf-pick-${i}" href="/r/${encodeURIComponent(p.link_slug)}">Obtener mi cupón</a>
    </li>`,
    )
    .join('');

  const config = safeJsonForHtml({
    slug: creator.slug,
    couponPath: `/v1/storefronts/${encodeURIComponent(creator.slug)}/products/`,
    items: products.map((p) => ({ productId: p.product_id, name: p.name })),
  });

  const body = `
<main>
  <section class="card profile">
    ${avatar}
    <div class="name-row"><h1>${name}</h1>${creator.is_verified ? '<span class="pill pill-verified">Verificado</span>' : ''}</div>
    <p class="handle">${escapeHtml(creator.handle)}</p>
    ${creator.bio ? `<p class="bio">${escapeHtml(creator.bio)}</p>` : ''}
    ${socials ? `<div class="socials">${socials}</div>` : ''}
  </section>

  <h2 class="section-title">Mis productos recomendados</h2>
  ${
    products.length > 0
      ? `<ul class="products">${cards}
  </ul>`
      : '<section class="card empty"><p>Pronto habrá productos recomendados aquí.</p></section>'
  }

  <section class="card panel hidden" id="sf-request" aria-live="polite">
    <h2>Tu cupón para <span id="sf-selected-name"></span></h2>
    <p class="muted">Recibe tu código al instante. Sin registro.</p>
    <form id="sf-form" novalidate>
      <label for="sf-email">Correo electrónico</label>
      <input id="sf-email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="tu@correo.com">
      <label for="sf-phone">o WhatsApp</label>
      <input id="sf-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="55 1234 5678">
      <label class="check"><input id="sf-wa" type="checkbox" disabled> Envíame un respaldo por WhatsApp</label>
      <p class="error" id="sf-error" role="alert" aria-live="assertive"></p>
      <button class="btn" id="sf-submit" type="submit">Obtener mi cupón</button>
    </form>
  </section>

  <section class="card panel hidden" id="sf-result" aria-live="polite">
    <div class="result-head"><h2>¡Cupón activado!</h2><span class="pill pill-mint">Listo</span></div>
    <div class="code-box">
      <div>
        <span class="code-label">Tu código de descuento</span>
        <span class="code num" id="sf-code" tabindex="-1"></span>
      </div>
      <button class="copy" id="sf-copy" type="button">Copiar</button>
    </div>
    <p class="expiry">Vence en <span class="timer num" id="sf-timer">48:00:00</span></p>
    <a class="btn" id="sf-go" href="#" rel="noopener">Ir a la tienda con mi descuento</a>
    <p class="muted">Se aplica automáticamente al pagar.</p>
  </section>
</main>
<script type="application/json" id="sf-config">${config}</script>
<script nonce="${opts.nonce}">${SCRIPT}</script>`;

  return shell({
    title: `${creator.name} · Recomendaciones con descuento | Referrals`,
    description: `Productos recomendados por ${creator.handle} con cupones de descuento de un solo uso.`,
    nonce: opts.nonce,
    body,
  });
}

export function renderStorefrontNotFoundPage(opts: { nonce: string }): string {
  return shell({
    title: 'Tienda no encontrada | Referrals',
    nonce: opts.nonce,
    body: `
<main><section class="card"><h1>Tienda no encontrada</h1><p class="muted">Este creador no tiene una tienda activa. Revisa que el enlace esté bien escrito.</p></section></main>`,
  });
}
