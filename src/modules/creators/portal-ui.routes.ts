import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Creator } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import type { HooksGenerator } from '../catalog/hooks-generator.js';
import { setPageHeaders } from '../links/links.routes.js';
import type { InvitationsService } from '../matchmaker/invitations.service.js';
import type { StorefrontService } from '../storefront/coupon.service.js';
import type { CreatorsRepository } from './creators.repository.js';
import { PORTAL_SESSION_COOKIE, readCookie, type MagicSessions } from './magic-link.js';
import { PayoutProfileSchema } from './payouts.routes.js';
import type { PayoutsService } from './payouts.service.js';
import {
  renderInvitationsInboxPage,
  renderPortalSignedOutPage,
  renderStorefrontManagePage,
  renderWalletPage,
  type Flash,
} from './portal-ui.template.js';

export interface PortalUiRouteDeps {
  creatorsRepo: CreatorsRepository;
  payouts: PayoutsService;
  storefront: StorefrontService;
  invitations: InvitationsService;
  hooks: HooksGenerator;
  sessions: MagicSessions;
  publicLinkBaseUrl: string;
  now?: () => Date;
}

/**
 * Outcome codes carried across the post → redirect → get round trip. Only these
 * fixed messages are ever rendered (nothing from the query string is echoed).
 */
const FLASH: Record<string, Flash> = {
  profile_saved: { kind: 'success', message: '¡Cuenta guardada! Podrás retirar en 24 horas.' },
  withdrawal_requested: { kind: 'success', message: 'Retiro solicitado. Lo verás en tu banco por SPEI en cuanto se procese.' },
  item_shown: { kind: 'success', message: 'El producto ya se ve en tu vitrina.' },
  item_hidden: { kind: 'success', message: 'Ocultamos el producto de tu vitrina.' },
  INVALID_CLABE: { kind: 'error', message: 'Revisa tus datos: la CLABE debe tener 18 dígitos válidos y el nombre al menos 3 letras.' },
  PROFILE_LOCKED: { kind: 'error', message: 'Ya tienes una cuenta registrada. Para cambiarla, escríbenos a soporte.' },
  PAYOUT_PROFILE_INCOMPLETE: { kind: 'error', message: 'Registra tu cuenta CLABE antes de retirar.' },
  PAYOUT_ACCOUNT_COOLING_OFF: { kind: 'error', message: 'Tu cuenta se registró o cambió hace poco. Por seguridad, espera 24 horas para retirar.' },
  INSUFFICIENT_FUNDS: { kind: 'error', message: 'No tienes saldo disponible suficiente.' },
  BELOW_MINIMUM_WITHDRAWAL: { kind: 'error', message: 'El retiro mínimo es de $100.00 MXN.' },
  INVALID_FORM: { kind: 'error', message: 'La página expiró. Vuelve a intentarlo.' },
  NOT_FOUND: { kind: 'error', message: 'Ese producto ya no está en tu vitrina.' },
};

const RECOVERABLE = new Set([
  'PAYOUT_PROFILE_INCOMPLETE',
  'PAYOUT_ACCOUNT_COOLING_OFF',
  'INSUFFICIENT_FUNDS',
  'BELOW_MINIMUM_WITHDRAWAL',
]);

const ItemIdParams = z.object({ id: z.uuid() });
const VisibilitySchema = z.object({ is_active: z.enum(['true', 'false']) });
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);

const flashFrom = (request: FastifyRequest): Flash | null => {
  const status = (request.query as { status?: unknown }).status;
  return typeof status === 'string' && Object.hasOwn(FLASH, status) ? FLASH[status]! : null;
};

const nonce = () => randomBytes(16).toString('base64');

/** Public bio link on the link domain, e.g. https://referals.mx/@leo. */
export const vanityUrl = (publicLinkBaseUrl: string, creatorSlug: string) =>
  `${new URL(publicLinkBaseUrl).origin}/@${creatorSlug.toLowerCase()}`;

/**
 * Creator mobile portal, behind the creator-wide session cookie a magic link opens:
 *
 *   GET  /c/wallet                         balances, payout account, withdrawal history
 *   POST /c/wallet/payout-profile          first CLABE registration (form)
 *   POST /c/wallet/withdraw                withdraw the full available balance (form)
 *   GET  /c/storefront                     bio link + storefront items with hooks
 *   POST /c/storefront/items/:id/visibility show / hide an item (form)
 *   GET  /c/invitations                    invitation inbox
 *
 * Every POST needs the session's CSRF token and answers 303 back to its page
 * with a fixed outcome code (post → redirect → get, no JavaScript required).
 */
export function registerPortalUiRoutes(app: FastifyInstance, deps: PortalUiRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4 * 1024 }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    const authenticate = async (request: FastifyRequest): Promise<{ creator: Creator; cookie: string } | null> => {
      const cookie = readCookie(request.headers.cookie, PORTAL_SESSION_COOKIE);
      const creatorId = deps.sessions.portalCreatorId(cookie);
      if (!cookie || !creatorId) return null;
      const creator = await deps.creatorsRepo.findCreatorById(creatorId);
      if (!creator || creator.status !== 'active' || !deps.sessions.verifyPortal(cookie, creator, now())) return null;
      return { creator, cookie };
    };

    const signedOut = (reply: FastifyReply) => {
      const n = nonce();
      setPageHeaders(reply, n);
      return reply.code(401).header('Referrer-Policy', 'no-referrer').send(renderPortalSignedOutPage({ nonce: n }));
    };

    const page = (reply: FastifyReply, html: (nonce: string) => string) => {
      const n = nonce();
      // Product photos are https images hosted by sellers.
      setPageHeaders(reply, n, { formAction: "'self'", imgSrc: "'self' data: https:" });
      return reply.code(200).header('Referrer-Policy', 'no-referrer').send(html(n));
    };

    const back = (reply: FastifyReply, path: string, status: string) =>
      reply.code(303).header('Cache-Control', 'no-store').header('Location', `${path}?status=${encodeURIComponent(status)}`).send();

    /** Session + CSRF for a form post; null means "answer with the signed-out page". */
    const authorizeForm = async (request: FastifyRequest) => {
      const auth = await authenticate(request);
      if (!auth) return null;
      const body = (request.body ?? {}) as Record<string, unknown>;
      return { ...auth, body, csrfOk: deps.sessions.csrfMatches(auth.cookie, body.csrf) };
    };

    // ---------- Mi Billetera ----------

    scope.get('/c/wallet', async (request, reply) => {
      const auth = await authenticate(request);
      if (!auth) return signedOut(reply);
      const { creator } = auth;
      const [balance, withdrawals] = await Promise.all([deps.payouts.balance(creator), deps.payouts.listWithdrawals(creator)]);
      return page(reply, (n) =>
        renderWalletPage(
          {
            creatorName: creator.name,
            balance,
            profile: deps.payouts.toProfileDto(creator),
            withdrawals: withdrawals.data,
            flash: flashFrom(request),
            csrf: deps.sessions.csrfToken(auth.cookie),
            idempotencyKey: `wdr_${randomBytes(16).toString('base64url')}`,
          },
          { nonce: n },
        ),
      );
    });

    scope.post('/c/wallet/payout-profile', async (request, reply) => {
      const auth = await authorizeForm(request);
      if (!auth) return signedOut(reply);
      if (!auth.csrfOk) return back(reply, '/c/wallet', 'INVALID_FORM');
      // The portal only registers a first account; replacing one needs the API key (or support).
      if (auth.creator.speiClabe) return back(reply, '/c/wallet', 'PROFILE_LOCKED');

      const parsed = PayoutProfileSchema.safeParse({
        clabe: auth.body.clabe,
        legal_name: auth.body.legal_name,
        rfc: typeof auth.body.rfc === 'string' && auth.body.rfc.trim() ? auth.body.rfc : null,
      });
      if (!parsed.success) return back(reply, '/c/wallet', 'INVALID_CLABE');
      // Magic-link sessions are a weaker factor than the API key: hold the new account 24h.
      await deps.payouts.updateProfile(auth.creator, parsed.data, { holdNewAccount: true });
      return back(reply, '/c/wallet', 'profile_saved');
    });

    scope.post('/c/wallet/withdraw', async (request, reply) => {
      const auth = await authorizeForm(request);
      if (!auth) return signedOut(reply);
      const key = IdempotencyKey.safeParse(auth.body.idempotency_key);
      if (!auth.csrfOk || !key.success) return back(reply, '/c/wallet', 'INVALID_FORM');
      try {
        await deps.payouts.requestWithdrawal(auth.creator, { amountCents: null, idempotencyKey: key.data });
      } catch (err) {
        if (err instanceof AppError && RECOVERABLE.has(err.code)) return back(reply, '/c/wallet', err.code);
        throw err;
      }
      return back(reply, '/c/wallet', 'withdrawal_requested');
    });

    // ---------- Mi Vitrina ----------

    scope.get('/c/storefront', async (request, reply) => {
      const auth = await authenticate(request);
      if (!auth) return signedOut(reply);
      const { creator } = auth;
      const { items } = await deps.storefront.listMyItems(creator);
      return page(reply, (n) =>
        renderStorefrontManagePage(
          {
            creatorName: creator.name,
            vanityUrl: vanityUrl(deps.publicLinkBaseUrl, creator.slug),
            items: items.map((item) => ({
              ...item,
              hooks: deps.hooks.generate({ creatorSlug: creator.slug, productName: item.product_name, productCategory: item.category }),
            })),
            flash: flashFrom(request),
            csrf: deps.sessions.csrfToken(auth.cookie),
          },
          { nonce: n },
        ),
      );
    });

    scope.post('/c/storefront/items/:id/visibility', async (request, reply) => {
      const auth = await authorizeForm(request);
      if (!auth) return signedOut(reply);
      const params = ItemIdParams.safeParse(request.params);
      const input = VisibilitySchema.safeParse(auth.body);
      if (!auth.csrfOk || !input.success) return back(reply, '/c/storefront', 'INVALID_FORM');
      if (!params.success) return back(reply, '/c/storefront', 'NOT_FOUND');
      const isActive = input.data.is_active === 'true';
      try {
        await deps.storefront.updateMyItem(auth.creator, params.data.id, { is_active: isActive });
      } catch (err) {
        // Another creator's item is indistinguishable from a missing one.
        if (err instanceof AppError && err.statusCode === 404) return back(reply, '/c/storefront', 'NOT_FOUND');
        throw err;
      }
      return back(reply, '/c/storefront', isActive ? 'item_shown' : 'item_hidden');
    });

    // ---------- Invitaciones ----------

    scope.get('/c/invitations', async (request, reply) => {
      const auth = await authenticate(request);
      if (!auth) return signedOut(reply);
      const { data } = await deps.invitations.inbox(auth.creator, 'all');
      return page(reply, (n) => renderInvitationsInboxPage({ invitations: data }, { nonce: n }));
    });
  });
}
