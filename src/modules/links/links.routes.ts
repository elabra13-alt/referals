import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { renderLandingPage, renderUnavailablePage } from './landing-template.js';
import type { LinkAvailability } from './link-availability.js';
import { LinkSlugParamsSchema } from './links.schemas.js';
import { renderMarketingHomePage } from './marketing-template.js';
import type { LinksService } from './links.service.js';

export const CODE_REQUEST_PATH = '/v1/codes/request';
/**
 * Buyer demo linked from the homepage. A live link with this slug must exist in the
 * database (seller → product → campaign → creator link), otherwise /r/ shows the 404 page.
 */
export const DEMO_LINK_SLUG = 'valeria-serum-facial-iluminador-glow';

function parseSlug(params: unknown): string | null {
  const parsed = LinkSlugParamsSchema.safeParse(params);
  return parsed.success ? parsed.data.link_slug : null;
}

/** Locked-down headers for the buyer HTML: only our own nonce'd inline script/style may run. */
export function setPageHeaders(reply: FastifyReply, nonce: string, opts: { imgSrc?: string } = {}): void {
  reply
    .header('Content-Type', 'text/html; charset=utf-8')
    .header(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        `img-src ${opts.imgSrc ?? "'self' data:"}`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    )
    .header('X-Content-Type-Options', 'nosniff')
    .header('X-Frame-Options', 'DENY')
    .header('Referrer-Policy', 'strict-origin-when-cross-origin')
    // Availability can change at any moment (paused campaign, archived product).
    .header('Cache-Control', 'no-store');
}

export function registerLinkRoutes(app: FastifyInstance, deps: { service: LinksService }): void {
  // ---------- JSON preview (public) ----------
  app.get('/v1/links/:link_slug/preview', async (request, reply) => {
    const slug = parseSlug(request.params);
    if (!slug) throw new AppError(404, 'LINK_NOT_FOUND', 'This referral link does not exist.');
    const preview = await deps.service.preview(slug);
    return reply.header('Cache-Control', 'public, max-age=30').send(preview);
  });

  // ---------- Landing page (public HTML) ----------
  const landing = async (request: FastifyRequest, reply: FastifyReply) => {
    const nonce = randomBytes(16).toString('base64');
    setPageHeaders(reply, nonce);

    const slug = parseSlug(request.params);
    if (!slug) return reply.code(404).send(renderUnavailablePage('not_found', { nonce }));

    try {
      const preview = await deps.service.preview(slug);
      return reply.code(200).send(renderLandingPage(preview, { nonce, codeRequestUrl: CODE_REQUEST_PATH }));
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        return reply.code(404).send(renderUnavailablePage('not_found', { nonce }));
      }
      if (err instanceof AppError && err.statusCode === 410) {
        const reason = (err.details?.status ?? 'campaign_inactive') as Exclude<LinkAvailability, 'active'>;
        return reply.code(410).send(renderUnavailablePage(reason, { nonce }));
      }
      throw err;
    }
  };

  // /r is the short share URL (PUBLIC_LINK_BASE_URL); /l is the canonical landing path.
  app.get('/l/:link_slug', landing);
  app.get('/r/:link_slug', landing);

  // ---------- Marketing homepage (public HTML, same CSP as the landing pages) ----------
  const home = async (_request: FastifyRequest, reply: FastifyReply) => {
    const nonce = randomBytes(16).toString('base64');
    setPageHeaders(reply, nonce);
    return reply.code(200).send(renderMarketingHomePage({ nonce, demoLinkSlug: DEMO_LINK_SLUG }));
  };

  app.get('/', home);
  app.get('/home', home);
}
