import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { setPageHeaders } from '../links/links.routes.js';
import type { CreatorsRepository } from './creators.repository.js';
import { PORTAL_SESSION_COOKIE, portalCookie, readCookie, type MagicSessions } from './magic-link.js';
import { normalizeLoginPhone, type PortalAuthService } from './portal-auth.service.js';
import {
  renderLoginErrorPage,
  renderLoginPage,
  renderLoginPreviewPage,
  renderLoginSentPage,
  type LoginErrorKind,
} from './portal-auth.template.js';

export interface PortalAuthRouteDeps {
  auth: PortalAuthService;
  creatorsRepo: CreatorsRepository;
  sessions: MagicSessions;
  now?: () => Date;
}

/** Pre-session anti-CSRF cookie for the login form (random; the form carries its HMAC). */
export const LOGIN_FORM_COOKIE = 'ref_login';
const LOGIN_FORM_TTL_SECONDS = 30 * 60;
const LOGIN_FORM_VALUE = /^[A-Za-z0-9_-]{43}$/;

/** WhatsApp & co. fetch links to build previews; that fetch must not burn a single-use token. */
const LINK_PREVIEW_AGENT = /WhatsApp|facebookexternalhit|Facebot|TelegramBot|Twitterbot|Slackbot|Discordbot|LinkedInBot|SkypeUriPreview|Applebot/i;

const nonce = () => randomBytes(16).toString('base64');

/**
 * Passwordless portal login by WhatsApp:
 *
 *   GET  /c/login          phone form (already signed in → /c/wallet)
 *   POST /c/login          rate-limited (3 / 15 min per IP and per phone); always the same
 *                          confirmation, registered number or not
 *   GET  /c/login/verify   single-use token → 24h portal session cookie, 303 to /c/wallet
 */
export function registerPortalAuthRoutes(app: FastifyInstance, deps: PortalAuthRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 2 * 1024 }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    const send = (reply: FastifyReply, status: number, html: (nonce: string) => string, formAction = "'none'") => {
      const n = nonce();
      setPageHeaders(reply, n, { formAction });
      return reply.code(status).header('Referrer-Policy', 'no-referrer').send(html(n));
    };

    const csrfFor = (formCookie: string) => deps.sessions.csrfToken(`login|${formCookie}`);

    /** The form with a fresh pre-session cookie (and its CSRF token). */
    const loginForm = (reply: FastifyReply, status: number, extra: { phone?: string; error?: string } = {}) => {
      const formCookie = randomBytes(32).toString('base64url');
      reply.header(
        'Set-Cookie',
        `${LOGIN_FORM_COOKIE}=${formCookie}; Path=/c/login; Max-Age=${LOGIN_FORM_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
      );
      return send(reply, status, (n) => renderLoginPage({ csrf: csrfFor(formCookie), ...extra }, { nonce: n }), "'self'");
    };

    const errorPage = (reply: FastifyReply, status: number, kind: LoginErrorKind, retryAfterSeconds?: number) =>
      send(reply, status, (n) =>
        renderLoginErrorPage(kind, { nonce: n, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) }),
      );

    const signedIn = async (request: FastifyRequest): Promise<boolean> => {
      const cookie = readCookie(request.headers.cookie, PORTAL_SESSION_COOKIE);
      const creatorId = deps.sessions.portalCreatorId(cookie);
      if (!creatorId) return false;
      const creator = await deps.creatorsRepo.findCreatorById(creatorId);
      return !!creator && creator.status === 'active' && deps.sessions.verifyPortal(cookie, creator, now());
    };

    scope.get('/c/login', async (request, reply) => {
      if (await signedIn(request)) return reply.code(303).header('Cache-Control', 'no-store').header('Location', '/c/wallet').send();
      return loginForm(reply, 200);
    });

    scope.post('/c/login', async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const formCookie = readCookie(request.headers.cookie, LOGIN_FORM_COOKIE);
      const csrfOk = !!formCookie && LOGIN_FORM_VALUE.test(formCookie) && deps.sessions.csrfMatches(`login|${formCookie}`, body.csrf);
      if (!csrfOk) return loginForm(reply, 403, { error: 'La página expiró. Vuelve a intentarlo.' });

      const phone = normalizeLoginPhone(body.phone);
      if (!phone) {
        return loginForm(reply, 400, {
          phone: typeof body.phone === 'string' ? body.phone.slice(0, 20) : '',
          error: 'Escribe tu número de WhatsApp a 10 dígitos, por ejemplo 55 1234 5678.',
        });
      }

      const result = await deps.auth.requestLogin(phone, request.ip);
      if (result.status === 'rate_limited') {
        reply.header('Retry-After', String(result.retryAfterSeconds));
        return errorPage(reply, 429, 'rate_limited', result.retryAfterSeconds);
      }
      // Identical for registered and unknown numbers (the lookup runs after this response).
      return send(reply, 200, (n) => renderLoginSentPage({ nonce: n }));
    });

    scope.get('/c/login/verify', async (request, reply) => {
      if (LINK_PREVIEW_AGENT.test(request.headers['user-agent'] ?? '')) {
        return send(reply, 200, (n) => renderLoginPreviewPage({ nonce: n }));
      }
      const result = await deps.auth.consume((request.query as { token?: unknown }).token);
      if (result.status === 'invalid') return errorPage(reply, 401, 'invalid');
      if (result.status === 'expired') return errorPage(reply, 410, 'expired');

      const portal = deps.sessions.issuePortal(result.creator, now());
      // Token out of the address bar, history and any later Referer.
      return reply
        .code(303)
        .header('Set-Cookie', portalCookie(portal.value, portal.maxAgeSeconds))
        .header('Location', '/c/wallet')
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .send();
    });
  });
}
