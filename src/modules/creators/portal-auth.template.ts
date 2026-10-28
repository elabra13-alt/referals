import { escapeHtml } from '../links/landing-template.js';
import { renderPortalShell } from './portal-ui.template.js';

/**
 * Creator portal login (/c/login): phone form, the "check your WhatsApp"
 * confirmation and the link error pages. Same Solid Slate shell as the portal,
 * without the tab bar (nobody is signed in yet).
 */

export const LOGIN_SENT_MESSAGE = 'Si tu número está registrado, te enviamos un enlace de acceso por WhatsApp.';

export interface LoginFormView {
  csrf: string;
  /** Echoed back (escaped) after a validation error so the creator can fix it. */
  phone?: string;
  error?: string | null;
}

export function renderLoginPage(view: LoginFormView, opts: { nonce: string }): string {
  const error = view.error ? `<p class="flash flash-error" role="alert" id="phone-error">${escapeHtml(view.error)}</p>` : '';
  return renderPortalShell({
    title: 'Entrar | Referrals',
    nonce: opts.nonce,
    active: null,
    body: `
<main>
  <section class="card">
    <h1>Entra a tu portal</h1>
    <p class="muted">Escribe tu número de WhatsApp. Te enviaremos un enlace seguro para entrar, válido por 15 minutos.</p>
  </section>
  ${error}
  <section class="card">
    <form method="post" action="/c/login" novalidate>
      <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
      <label for="phone">Tu número de WhatsApp</label>
      <input type="tel" id="phone" name="phone" class="num" inputmode="tel" autocomplete="tel" maxlength="20" required
        placeholder="55 1234 5678" value="${escapeHtml(view.phone ?? '')}"${view.error ? ' aria-invalid="true" aria-describedby="phone-error"' : ''}>
      <p class="field-hint">10 dígitos, o con lada internacional: +52 55 1234 5678</p>
      <button class="btn btn-money" type="submit">Enviarme enlace por WhatsApp</button>
    </form>
  </section>
</main>`,
  });
}

export function renderLoginSentPage(opts: { nonce: string }): string {
  return renderPortalShell({
    title: 'Revisa tu WhatsApp | Referrals',
    nonce: opts.nonce,
    active: null,
    body: `
<main>
  <section class="card vanity" role="status">
    <h1>Revisa tu WhatsApp</h1>
    <p class="note">${LOGIN_SENT_MESSAGE}</p>
    <p class="muted">El enlace vence en 15 minutos y solo funciona una vez. ¿No te llegó? Espera un momento y vuelve a pedirlo.</p>
    <a class="btn btn-outline" href="/c/login">Pedir otro enlace</a>
  </section>
</main>`,
  });
}

export type LoginErrorKind = 'invalid' | 'expired' | 'rate_limited';

export function renderLoginErrorPage(kind: LoginErrorKind, opts: { nonce: string; retryAfterSeconds?: number }): string {
  const minutes = Math.max(1, Math.ceil((opts.retryAfterSeconds ?? 60) / 60));
  const copy: Record<LoginErrorKind, [string, string]> = {
    invalid: ['Enlace no válido', 'Este enlace de acceso no es válido. Pide uno nuevo con tu número de WhatsApp.'],
    expired: ['Este enlace ya no funciona', 'Los enlaces de acceso vencen en 15 minutos y solo se pueden usar una vez. Pide uno nuevo.'],
    rate_limited: [
      'Demasiados intentos',
      `Por seguridad, espera <span class="num">${minutes}</span> ${minutes === 1 ? 'minuto' : 'minutos'} antes de pedir otro enlace.`,
    ],
  };
  const [title, message] = copy[kind];
  return renderPortalShell({
    title: `${title} | Referrals`,
    nonce: opts.nonce,
    active: null,
    body: `
<main>
  <section class="card vanity">
    <h1>${title}</h1>
    <p class="muted">${message}</p>
    <a class="btn btn-dark" href="/c/login">Pedir un enlace nuevo</a>
  </section>
</main>`,
  });
}

/** Served to link-preview crawlers instead of burning the single-use token. */
export function renderLoginPreviewPage(opts: { nonce: string }): string {
  return renderPortalShell({
    title: 'Acceso a tu portal | Referrals',
    nonce: opts.nonce,
    active: null,
    body: `
<main><section class="card"><h1>Acceso a tu portal de creador</h1><p class="muted">Abre el enlace para entrar.</p></section></main>`,
  });
}
