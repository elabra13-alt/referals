import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import { createAdminAuth, createSellerAuth, requireSeller } from './sellers.auth.js';
import type { SellersRepository } from './sellers.repository.js';
import {
  CreateCampaignSchema,
  CreateProductSchema,
  IdParamsSchema,
  ListCampaignsQuerySchema,
  ListProductsQuerySchema,
  OnboardSellerSchema,
  UpdateCampaignSchema,
  UpdateProductSchema,
  toSellerDto,
} from './sellers.schemas.js';
import type { SellersService } from './sellers.service.js';

export interface SellerRouteDeps {
  repo: SellersRepository;
  service: SellersService;
  adminApiToken?: string | undefined;
}

/** Non-UUID ids can't exist, so they 404 like any other unknown id. */
function parseId(params: unknown, notFound: { code: string; message: string }): string {
  const parsed = IdParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new AppError(404, notFound.code, notFound.message);
  }
  return parsed.data.id;
}

export function registerSellerRoutes(app: FastifyInstance, deps: SellerRouteDeps): void {
  const { service } = deps;
  const productNotFound = { code: 'PRODUCT_NOT_FOUND', message: 'Product not found.' };
  const campaignNotFound = { code: 'CAMPAIGN_NOT_FOUND', message: 'Campaign not found.' };

  // ---------- Onboarding (platform operator) ----------
  app.post('/v1/sellers', { preHandler: createAdminAuth(deps.adminApiToken) }, async (request, reply) => {
    const input = parseOrThrow(OnboardSellerSchema, request.body);
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(await service.onboard(input));
  });

  // ---------- Seller-authenticated API ----------
  void app.register(async (scope) => {
    scope.addHook('preHandler', createSellerAuth(deps.repo));
    scope.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    scope.get('/v1/seller', async (request) => toSellerDto(requireSeller(request)));

    scope.post('/v1/seller/api-key/rotate', async (request) => service.rotateApiKey(requireSeller(request).id));

    scope.post('/v1/seller/webhook-secret/rotate', async (request) =>
      service.rotateWebhookSecret(requireSeller(request).id),
    );

    // Products
    scope.post('/v1/products', async (request, reply) => {
      const input = parseOrThrow(CreateProductSchema, request.body);
      return reply.code(201).send(await service.createProduct(requireSeller(request).id, input));
    });

    scope.get('/v1/products', async (request) =>
      service.listProducts(requireSeller(request).id, parseOrThrow(ListProductsQuerySchema, request.query)),
    );

    scope.get('/v1/products/:id', async (request) =>
      service.getProduct(requireSeller(request).id, parseId(request.params, productNotFound)),
    );

    scope.patch('/v1/products/:id', async (request) => {
      const id = parseId(request.params, productNotFound);
      return service.updateProduct(requireSeller(request).id, id, parseOrThrow(UpdateProductSchema, request.body));
    });

    scope.delete('/v1/products/:id', async (request) =>
      service.archiveProduct(requireSeller(request).id, parseId(request.params, productNotFound)),
    );

    // Campaigns
    scope.post('/v1/campaigns', async (request, reply) => {
      const input = parseOrThrow(CreateCampaignSchema, request.body);
      return reply.code(201).send(await service.createCampaign(requireSeller(request).id, input));
    });

    scope.get('/v1/campaigns', async (request) =>
      service.listCampaigns(requireSeller(request).id, parseOrThrow(ListCampaignsQuerySchema, request.query)),
    );

    scope.get('/v1/campaigns/:id', async (request) =>
      service.getCampaign(requireSeller(request).id, parseId(request.params, campaignNotFound)),
    );

    scope.patch('/v1/campaigns/:id', async (request) => {
      const id = parseId(request.params, campaignNotFound);
      return service.updateCampaign(requireSeller(request).id, id, parseOrThrow(UpdateCampaignSchema, request.body));
    });
  });
}
