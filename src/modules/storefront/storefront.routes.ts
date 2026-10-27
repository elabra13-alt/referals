import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import type { AntiFraudShield } from '../codes/anti-fraud-shield.js';
import { createCreatorAuth, requireCreator } from '../creators/creators.auth.js';
import type { CreatorsRepository } from '../creators/creators.repository.js';
import { setPageHeaders } from '../links/links.routes.js';
import type { StorefrontService } from './coupon.service.js';
import {
  ItemIdParamsSchema,
  StorefrontCouponParamsSchema,
  StorefrontSlugParamsSchema,
  UpdateStorefrontItemSchema,
  UpsertStorefrontItemSchema,
} from './storefront.schemas.js';
import { renderStorefrontNotFoundPage, renderStorefrontPage } from './storefront-template.js';

export interface StorefrontRouteDeps {
  service: StorefrontService;
  shield: AntiFraudShield;
  creatorsRepo: CreatorsRepository;
}

const notFound = () => new AppError(404, 'STOREFRONT_NOT_FOUND', 'This storefront does not exist.');

function slugFrom(params: unknown): string {
  const parsed = StorefrontSlugParamsSchema.safeParse(params);
  if (!parsed.success) throw notFound();
  return parsed.data.slug;
}

export function registerStorefrontRoutes(app: FastifyInstance, deps: StorefrontRouteDeps): void {
  const { service } = deps;

  // ---------- Public JSON ----------
  app.get('/v1/storefronts/:slug', async (request, reply) => {
    const storefront = await service.getStorefront(slugFrom(request.params));
    return reply.header('Cache-Control', 'public, max-age=30').send(storefront);
  });

  /**
   * Single-use coupon for one storefront product. Same contract and protections as
   * POST /v1/codes/request: IP sliding window (checked first, so invalid requests
   * count too), disposable-email block, 24h one-code-per-buyer (409 + existing code).
   */
  app.post('/v1/storefronts/:slug/products/:productId/coupons', async (request, reply) => {
    await deps.shield.enforceIpRateLimit(request.ip);
    const parsed = StorefrontCouponParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw new AppError(404, 'PRODUCT_NOT_IN_STOREFRONT', 'This product is not available in this storefront.');
    }
    const outcome = await service.requestCoupon(parsed.data.slug, parsed.data.productId, request.body);

    reply.header('Cache-Control', 'no-store');
    const context = { product_id: outcome.productId, creator_slug: outcome.creatorSlug };
    if (outcome.kind === 'duplicate') {
      return reply.code(409).send({
        error: { code: 'ACTIVE_CODE_EXISTS', message: 'You already have an active code for this offer.' },
        existing_code: outcome.code,
        ...context,
      });
    }
    return reply.code(201).send({ ...outcome.code, ...context, delivery: { whatsapp_backup: outcome.whatsappBackup } });
  });

  // ---------- Public HTML: /c/:slug and /@:slug ----------
  const page = async (request: FastifyRequest, reply: FastifyReply) => {
    const nonce = randomBytes(16).toString('base64');
    // Creator avatars are https images hosted elsewhere.
    setPageHeaders(reply, nonce, { imgSrc: "'self' data: https:" });
    try {
      const storefront = await service.getStorefront(slugFrom(request.params));
      return reply.code(200).send(renderStorefrontPage(storefront, { nonce }));
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        return reply.code(404).send(renderStorefrontNotFoundPage({ nonce }));
      }
      throw err;
    }
  };
  app.get('/c/:slug', page);
  app.get('/@:slug', page);

  // ---------- Creator self-service: curate the storefront ----------
  void app.register(async (scope) => {
    scope.addHook('preHandler', createCreatorAuth(deps.creatorsRepo));
    scope.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    scope.get('/v1/creators/me/storefront', async (request) => service.listMyItems(requireCreator(request)));

    scope.post('/v1/creators/me/storefront/items', async (request, reply) => {
      const input = parseOrThrow(UpsertStorefrontItemSchema, request.body);
      const { created, item } = await service.upsertMyItem(requireCreator(request), input);
      return reply.code(created ? 201 : 200).send(item);
    });

    const itemId = (params: unknown) => {
      const parsed = ItemIdParamsSchema.safeParse(params);
      if (!parsed.success) throw new AppError(404, 'STOREFRONT_ITEM_NOT_FOUND', 'Storefront item not found.');
      return parsed.data.id;
    };

    scope.patch('/v1/creators/me/storefront/items/:id', async (request) =>
      service.updateMyItem(requireCreator(request), itemId(request.params), parseOrThrow(UpdateStorefrontItemSchema, request.body)),
    );

    scope.delete('/v1/creators/me/storefront/items/:id', async (request, reply) => {
      await service.deleteMyItem(requireCreator(request), itemId(request.params));
      return reply.code(204).send();
    });
  });
}
