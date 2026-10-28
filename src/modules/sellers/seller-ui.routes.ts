import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { hashApiKey, isWellFormedApiKey, safeEqual } from '../../lib/keys.js';
import type { RedisClient } from '../../lib/redis.js';
import { parseOrThrow } from '../../lib/validation.js';
import { estimatedCommission } from '../catalog/catalog.service.js';
import { SLIDING_WINDOW_LUA } from '../codes/anti-fraud-shield.js';
import { readCookie } from '../creators/magic-link.js';
import { setPageHeaders } from '../links/links.routes.js';
import type { InvitationsService } from '../matchmaker/invitations.service.js';
import { CreateInvitationSchema } from '../matchmaker/matchmaker.routes.js';
import type { MatchmakerDto, MatchmakerService } from '../matchmaker/matchmaker.service.js';
import type { DashboardSeller, SellerDashboardService } from './seller-dashboard.service.js';
import { SELLER_SESSION_COOKIE, sellerSessionCookie, type SellerSessions } from './seller-session.js';
import { renderSellerDashboardPage, renderSellerLoginPage, type Flash, type MatchCard, type MatchState } from './seller-ui.template.js';
import { CreateCampaignSchema } from './sellers.schemas.js';
import type { SellersRepository } from './sellers.repository.js';
import type { SellersService } from './sellers.service.js';

export interface SellerUiRouteDeps {
  sellersRepo: SellersRepository;
  sellersService: SellersService;
  dashboard: SellerDashboardService;
  matchmaker: MatchmakerService;
  invitations: InvitationsService;
  sessions: SellerSessions;
  redis: RedisClient;
  adminApiToken?: string | undefined;
  now?: () => Date;
}

/** Pre-session anti-CSRF cookie for the sign-in form. */
export const SELLER_LOGIN_FORM_COOKIE = 'ref_seller_login';
const LOGIN_FORM_VALUE = /^[A-Za-z0-9_-]{43}$/;
/** Sign-in attempts per IP (API keys are high-entropy; this guards the admin token). */
export const SELLER_LOGIN_RATE_LIMIT = { MAX_ATTEMPTS: 10, WINDOW_MS: 15 * 60 * 1000 } as const;
const MATCHES_SHOWN = 12;

const FLASH: Record<string, Flash> = {
  invited: { kind: 'success', message: 'Invitación enviada por WhatsApp. Vence en 7 días.' },
  campaign_created: { kind: 'success', message: '¡Campaña lanzada! Estos son tus creadores recomendados.' },
  INVALID_FORM: { kind: 'error', message: 'La página expiró. Vuelve a intentarlo.' },
  INVALID_CAMPAIGN: { kind: 'error', message: 'Revisa la campaña: elige un producto y una comisión entre 1% y 100%.' },
  PRODUCT_NOT_ACTIVE: { kind: 'error', message: 'Solo puedes lanzar campañas para productos activos.' },
  PRODUCT_NOT_FOUND: { kind: 'error', message: 'Ese producto no existe en tu catálogo.' },
  CREATOR_NOT_FOUND: { kind: 'error', message: 'Ese creador ya no está disponible.' },
  INVITATION_PENDING_LIMIT_REACHED: { kind: 'error', message: 'Límite de 25 invitaciones pendientes alcanzado.' },
  DAILY_INVITATION_QUOTA_EXCEEDED: { kind: 'error', message: 'Límite diario de 50 invitaciones alcanzado.' },
  INVITATION_PENDING: { kind: 'error', message: 'Este creador ya tiene una invitación pendiente.' },
  INVITATION_DECLINED: { kind: 'error', message: 'Este creador declinó esta campaña.' },
  ALREADY_JOINED: { kind: 'error', message: 'Este creador ya promociona esta campaña.' },
  CREATOR_SUSPENDED: { kind: 'error', message: 'Este creador no está aceptando campañas.' },
  CAMPAIGN_NOT_ACTIVE: { kind: 'error', message: 'La campaña o el producto no están activos.' },
  CAMPAIGN_NOT_FOUND: { kind: 'error', message: 'Campaña no encontrada.' },
};

const InviteFormSchema = z.object({ campaign_id: z.uuid(), csrf: z.string().max(128) });
const LaunchFormSchema = z.object({
  product_id: z.string(),
  commission_percent: z.coerce.number().min(1).max(100),
  is_public_catalog: z.literal('true').optional(),
});
const CampaignQuery = z.object({ campaign: z.uuid().optional(), status: z.string().max(64).optional() });

const nonce = () => randomBytes(16).toString('base64');

function matchState(match: MatchmakerDto): { state: MatchState; resend: boolean } {
  if (match.already_linked || match.invitation?.status === 'accepted') return { state: 'joined', resend: false };
  if (match.invitation?.status === 'pending') return { state: 'pending', resend: false };
  if (match.invitation?.status === 'declined') return { state: 'declined', resend: false };
  return { state: 'invitable', resend: match.invitation?.status === 'expired' };
}

/**
 * Seller web dashboard, behind the `ref_seller` session cookie:
 *
 *   GET  /seller/login                 sign-in form (API key, or admin token + seller id)
 *   POST /seller/login                 → session cookie, 303 /seller/dashboard
 *   POST /seller/logout                clears the session
 *   GET  /seller/dashboard[?campaign=] KPIs, campaigns, Visual Matchmaker for one campaign
 *   POST /seller/dashboard/invite      same rules as POST /v1/campaigns/:id/invitations
 *                                      (JSON for the inline script, 303 for plain forms)
 *   POST /seller/dashboard/campaigns   launch a campaign (form)
 *
 * Every query is scoped to the signed-in seller; another seller's campaign is a 404.
 */
export function registerSellerUiRoutes(app: FastifyInstance, deps: SellerUiRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4 * 1024 }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    const isForm = (request: FastifyRequest) => (request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
    const redirect = (reply: FastifyReply, location: string) =>
      reply.code(303).header('Cache-Control', 'no-store').header('Location', location).send();
    const dashboardUrl = (campaignId: string | null, status?: string) => {
      const params = new URLSearchParams();
      if (campaignId) params.set('campaign', campaignId);
      if (status) params.set('status', status);
      const qs = params.toString();
      return `/seller/dashboard${qs ? `?${qs}` : ''}`;
    };

    const authenticate = async (request: FastifyRequest): Promise<{ seller: DashboardSeller; cookie: string } | null> => {
      const cookie = readCookie(request.headers.cookie, SELLER_SESSION_COOKIE);
      const sellerId = deps.sessions.sellerId(cookie);
      if (!cookie || !sellerId) return null;
      const seller = await deps.dashboard.findSeller(sellerId);
      if (!seller || seller.status !== 'active' || !deps.sessions.verify(cookie, seller, now())) return null;
      return { seller, cookie };
    };

    // ---------- Sign-in ----------

    const loginForm = (reply: FastifyReply, status: number, error: string | null = null) => {
      const formCookie = randomBytes(32).toString('base64url');
      const n = nonce();
      setPageHeaders(reply, n, { formAction: "'self'" });
      return reply
        .code(status)
        .header('Set-Cookie', `${SELLER_LOGIN_FORM_COOKIE}=${formCookie}; Path=/seller/login; Max-Age=1800; HttpOnly; Secure; SameSite=Strict`)
        .header('Referrer-Policy', 'no-referrer')
        .send(
          renderSellerLoginPage(
            { csrf: deps.sessions.csrfToken(`login|${formCookie}`), error, adminEnabled: !!deps.adminApiToken },
            { nonce: n },
          ),
        );
    };

    const loginAttempt = async (ip: string) => {
      const nowMs = now().getTime();
      const raw = (await deps.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        `rl:seller-login:ip:${ip}`,
        nowMs,
        SELLER_LOGIN_RATE_LIMIT.WINDOW_MS,
        SELLER_LOGIN_RATE_LIMIT.MAX_ATTEMPTS,
        `${nowMs}:${randomUUID()}`,
      )) as [number, number, number];
      const [allowed, , retryAfterMs] = raw.map(Number) as [number, number, number];
      return { allowed: allowed === 1, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    };

    scope.get('/seller/login', async (request, reply) => {
      if (await authenticate(request)) return redirect(reply, '/seller/dashboard');
      return loginForm(reply, 200);
    });

    scope.post('/seller/login', async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const formCookie = readCookie(request.headers.cookie, SELLER_LOGIN_FORM_COOKIE);
      const csrfOk = !!formCookie && LOGIN_FORM_VALUE.test(formCookie) && deps.sessions.csrfMatches(`login|${formCookie}`, body.csrf);
      if (!csrfOk) return loginForm(reply, 403, 'La página expiró. Vuelve a intentarlo.');

      const attempt = await loginAttempt(request.ip);
      if (!attempt.allowed) {
        reply.header('Retry-After', String(attempt.retryAfterSeconds));
        return loginForm(reply, 429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
      }

      let sellerId: string | null = null;
      if (typeof body.api_key === 'string' && body.api_key.trim()) {
        const apiKey = body.api_key.trim();
        if (isWellFormedApiKey(apiKey)) sellerId = (await deps.sellersRepo.findSellerByApiKeyHash(hashApiKey(apiKey)))?.id ?? null;
      } else if (
        deps.adminApiToken &&
        typeof body.admin_token === 'string' &&
        safeEqual(body.admin_token, deps.adminApiToken) &&
        typeof body.seller_id === 'string' &&
        z.uuid().safeParse(body.seller_id.trim()).success
      ) {
        sellerId = body.seller_id.trim();
      }
      const seller = sellerId ? await deps.dashboard.findSeller(sellerId) : null;
      // One generic answer for every failure (no hint about which part was wrong).
      if (!seller || seller.status !== 'active') return loginForm(reply, 401, 'No pudimos iniciar sesión con esos datos.');

      const session = deps.sessions.issue(seller, now());
      return reply
        .code(303)
        .header('Set-Cookie', sellerSessionCookie(session.value, session.maxAgeSeconds))
        .header('Location', '/seller/dashboard')
        .header('Cache-Control', 'no-store')
        .send();
    });

    scope.post('/seller/logout', async (_request, reply) =>
      reply
        .code(303)
        .header('Set-Cookie', sellerSessionCookie('', 0))
        .header('Location', '/seller/login')
        .header('Cache-Control', 'no-store')
        .send(),
    );

    // ---------- Dashboard ----------

    scope.get('/seller/dashboard', async (request, reply) => {
      const auth = await authenticate(request);
      if (!auth) return redirect(reply, '/seller/login');
      const { seller } = auth;
      const query = CampaignQuery.safeParse(request.query);
      const requested = query.success ? query.data.campaign : undefined;
      const status = query.success ? query.data.status : undefined;

      const [kpis, campaigns, products] = await Promise.all([
        deps.dashboard.kpis(seller.id),
        deps.dashboard.campaigns(seller.id),
        deps.dashboard.activeProducts(seller.id),
      ]);

      // ?campaign= must be one of this seller's: another seller's id is a 404, like a missing one.
      const chosen = requested
        ? campaigns.find((c) => c.campaign.id === requested)
        : (campaigns.find((c) => c.campaign.status === 'active' && c.product.status === 'active') ?? campaigns[0]);
      const notFound = !!requested && !chosen;

      let selected = null;
      let matches: MatchCard[] = [];
      if (chosen) {
        const [ranked, quota] = await Promise.all([
          deps.matchmaker.rankWithCreators(seller.id, chosen.campaign.id, { limit: MATCHES_SHOWN }),
          deps.invitations.quotaFor(seller.id, chosen.campaign.id),
        ]);
        selected = {
          id: chosen.campaign.id,
          productName: chosen.product.name,
          currency: chosen.product.currency,
          estimatedPayout: estimatedCommission(chosen.product.price, chosen.campaign.commissionRate),
          quota,
          canInvite: chosen.campaign.status === 'active' && chosen.product.status === 'active',
        };
        matches = ranked.entries.map(({ creator, match }) => ({
          slug: creator.slug,
          name: creator.name,
          handle: creator.handle,
          avatarUrl: creator.avatarUrl,
          instagramHandle: creator.instagramHandle,
          tiktokHandle: creator.tiktokHandle,
          score: match.score,
          tags: match.tags,
          followers: creator.followersCount,
          engagementRate: creator.engagementRate,
          expiresAt: match.invitation?.expires_at ?? null,
          ...matchState(match),
        }));
      }

      const n = nonce();
      // Product photos and creator avatars are https images hosted elsewhere.
      setPageHeaders(reply, n, { formAction: "'self'", imgSrc: "'self' data: https:" });
      return reply
        .code(notFound ? 404 : 200)
        .header('Referrer-Policy', 'no-referrer')
        .send(
          renderSellerDashboardPage(
            {
              seller: { name: seller.name, storeDomain: seller.storeDomain, buyerDiscountPercent: seller.buyerDiscountPercent },
              kpis,
              campaigns: campaigns.map((c) => ({
                id: c.campaign.id,
                productName: c.product.name,
                productImageUrl: c.product.imageUrl,
                commissionRate: c.campaign.commissionRate,
                status: c.campaign.status,
                isPublicCatalog: c.campaign.isPublicCatalog,
              })),
              selected,
              matches,
              products,
              flash: notFound ? FLASH.CAMPAIGN_NOT_FOUND! : status && Object.hasOwn(FLASH, status) ? FLASH[status]! : null,
              csrf: deps.sessions.csrfToken(auth.cookie),
              now: now(),
            },
            { nonce: n },
          ),
        );
    });

    scope.post('/seller/dashboard/invite', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const form = isForm(request);
      const auth = await authenticate(request);
      if (!auth) {
        if (form) return redirect(reply, '/seller/login');
        throw new AppError(401, 'SESSION_EXPIRED', 'Sign in to the dashboard again.');
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const target = InviteFormSchema.safeParse(body);
      const campaignId = target.success ? target.data.campaign_id : null;
      if (!deps.sessions.csrfMatches(auth.cookie, body.csrf)) {
        if (form) return redirect(reply, dashboardUrl(campaignId, 'INVALID_FORM'));
        throw new AppError(403, 'CSRF_TOKEN_INVALID', 'Reload the dashboard and try again.');
      }
      if (!campaignId) {
        if (form) return redirect(reply, dashboardUrl(null, 'CAMPAIGN_NOT_FOUND'));
        throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');
      }

      try {
        const input = parseOrThrow(CreateInvitationSchema, {
          creator_slug: body.creator_slug,
          custom_note: typeof body.custom_note === 'string' ? body.custom_note : null,
        });
        const invitation = await deps.invitations.invite(auth.seller.id, campaignId, input);
        if (form) return redirect(reply, dashboardUrl(campaignId, 'invited'));
        return reply.code(201).send(invitation);
      } catch (err) {
        if (form && err instanceof AppError && err.statusCode < 500) {
          const code = Object.hasOwn(FLASH, err.code) ? err.code : 'INVALID_FORM';
          // A foreign campaign stays unnamed: back to the default dashboard.
          return redirect(reply, dashboardUrl(err.code === 'CAMPAIGN_NOT_FOUND' ? null : campaignId, code));
        }
        throw err;
      }
    });

    scope.post('/seller/dashboard/campaigns', async (request, reply) => {
      const auth = await authenticate(request);
      if (!auth) return redirect(reply, '/seller/login');
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!deps.sessions.csrfMatches(auth.cookie, body.csrf)) return redirect(reply, dashboardUrl(null, 'INVALID_FORM'));

      const form = LaunchFormSchema.safeParse(body);
      const input = form.success
        ? CreateCampaignSchema.safeParse({
            product_id: form.data.product_id,
            commission_rate: Math.round(form.data.commission_percent * 100) / 10_000,
            is_public_catalog: form.data.is_public_catalog === 'true',
          })
        : null;
      if (!input?.success) return redirect(reply, dashboardUrl(null, 'INVALID_CAMPAIGN'));

      try {
        const campaign = await deps.sellersService.createCampaign(auth.seller.id, input.data);
        return redirect(reply, dashboardUrl(campaign.id, 'campaign_created'));
      } catch (err) {
        if (err instanceof AppError && Object.hasOwn(FLASH, err.code)) return redirect(reply, dashboardUrl(null, err.code));
        throw err;
      }
    });
  });
}
