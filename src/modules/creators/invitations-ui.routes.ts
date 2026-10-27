import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import { setPageHeaders } from '../links/links.routes.js';
import type { InvitationsService, MagicAccess } from '../matchmaker/invitations.service.js';
import { renderInvitationErrorPage, renderInvitationPage, type InvitationErrorKind } from './invitations-ui.template.js';
import {
  MAGIC_SESSION_COOKIE,
  PORTAL_SESSION_COOKIE,
  portalCookie,
  readCookie,
  sessionCookie,
  sessionCookiePath,
  type MagicSessions,
  type MagicSessionSubject,
} from './magic-link.js';

export interface InvitationUiRouteDeps {
  invitations: InvitationsService;
  sessions: MagicSessions;
  now?: () => Date;
}

const IdParams = z.object({ id: z.uuid() });
const RespondSchema = z.object({ action: z.enum(['accept', 'decline']), csrf: z.string().max(128) });

const subjectOf = (access: MagicAccess): MagicSessionSubject => ({
  invitationId: access.row.invitation.id,
  creatorId: access.creator.id,
  magicTokenHash: access.row.invitation.magicTokenHash,
});

const sessionExpired = () =>
  new AppError(401, 'SESSION_EXPIRED', 'Open the invitation again from your WhatsApp link.');

/**
 * Mobile invitation page reached from the creator's WhatsApp notice:
 *
 *   GET  /c/invitations/:id?token=…  magic token → session cookie, 303 to the clean URL
 *   GET  /c/invitations/:id          the page (session cookie required)
 *   POST /c/invitations/:id/respond  accept | decline (session + CSRF token); JSON for the
 *                                    inline script, 303 back to the page for plain forms
 */
export function registerInvitationUiRoutes(app: FastifyInstance, deps: InvitationUiRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  void app.register(async (scope) => {
    // No-JS fallback posts the form urlencoded.
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4 * 1024 }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    const errorPage = (reply: FastifyReply, status: number, kind: InvitationErrorKind) => {
      const nonce = randomBytes(16).toString('base64');
      setPageHeaders(reply, nonce);
      return reply.code(status).header('Referrer-Policy', 'no-referrer').send(renderInvitationErrorPage(kind, { nonce }));
    };

    const invitationId = (params: unknown): string | null => {
      const parsed = IdParams.safeParse(params);
      return parsed.success ? parsed.data.id : null;
    };

    /**
     * This invitation's session (checked against its current token hash and creator),
     * or the owning creator's portal session.
     */
    const authenticate = async (request: FastifyRequest, id: string) => {
      const invitationCookie = readCookie(request.headers.cookie, MAGIC_SESSION_COOKIE);
      const portal = readCookie(request.headers.cookie, PORTAL_SESSION_COOKIE);
      if (!invitationCookie && !portal) return null;
      const access = await deps.invitations.sessionSubject(id);
      if (!access) return null;
      if (invitationCookie && deps.sessions.verify(invitationCookie, subjectOf(access), now())) {
        return { access, cookie: invitationCookie };
      }
      if (portal && deps.sessions.verifyPortal(portal, access.creator, now())) return { access, cookie: portal };
      return null;
    };

    scope.get('/c/invitations/:id', async (request, reply) => {
      const id = invitationId(request.params);
      // A malformed id is just another invalid link (no enumeration signal).
      if (!id) return errorPage(reply, 401, 'invalid');

      const token = (request.query as { token?: unknown }).token;
      if (typeof token === 'string') {
        let access: MagicAccess;
        try {
          access = await deps.invitations.openMagicLink(id, token);
        } catch (err) {
          if (err instanceof AppError && err.statusCode === 401) return errorPage(reply, 401, 'invalid');
          if (err instanceof AppError && err.statusCode === 410) return errorPage(reply, 410, 'expired');
          throw err;
        }
        const session = deps.sessions.issue(subjectOf(access), now());
        const portal = deps.sessions.issuePortal(access.creator, now());
        // Drop the token from the address bar, history and any later Referer.
        return reply
          .code(303)
          .header('Set-Cookie', [
            sessionCookie(id, session.value, session.maxAgeSeconds),
            // Also opens the creator portal (wallet, storefront, inbox) for the same 24h.
            portalCookie(portal.value, portal.maxAgeSeconds),
          ])
          .header('Location', sessionCookiePath(id))
          .header('Cache-Control', 'no-store')
          .header('Referrer-Policy', 'no-referrer')
          .send();
      }

      const auth = await authenticate(request, id);
      if (!auth) return errorPage(reply, 401, 'session');
      const view = await deps.invitations.pageView(auth.access.creator, id);
      const nonce = randomBytes(16).toString('base64');
      // Product photos are https images hosted by the seller.
      setPageHeaders(reply, nonce, { formAction: "'self'", imgSrc: "'self' data: https:" });
      return reply
        .code(200)
        .header('Referrer-Policy', 'no-referrer')
        .send(
          renderInvitationPage(view, {
            nonce,
            csrf: deps.sessions.csrfToken(auth.cookie),
            respondPath: `${sessionCookiePath(id)}/respond`,
          }),
        );
    });

    scope.post('/c/invitations/:id/respond', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const isForm = (request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
      const id = invitationId(request.params);
      const auth = id ? await authenticate(request, id) : null;
      if (!id || !auth) {
        if (isForm) return errorPage(reply, 401, 'session');
        throw sessionExpired();
      }

      const input = parseOrThrow(RespondSchema, request.body);
      if (!deps.sessions.csrfMatches(auth.cookie, input.csrf)) {
        throw new AppError(403, 'CSRF_TOKEN_INVALID', 'Reload the invitation page and try again.');
      }

      const { creator } = auth.access;
      const backToPage = () => reply.code(303).header('Location', sessionCookiePath(id)).send();
      try {
        if (input.action === 'accept') {
          const result = await deps.invitations.accept(creator, id);
          if (isForm) return backToPage();
          return reply.code(result.status === 'accepted' ? 201 : 200).send({
            status: result.status,
            link_url: result.link.url,
            storefront_url: result.storefront.url,
          });
        }
        await deps.invitations.decline(creator, id);
        if (isForm) return backToPage();
        return reply.code(200).send({ status: 'declined' });
      } catch (err) {
        // Plain forms: the page itself shows why (expired, declined, campaign closed).
        if (isForm && err instanceof AppError && err.statusCode < 500) return backToPage();
        throw err;
      }
    });
  });
}
