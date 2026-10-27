import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import { createAdminAuth, createSellerAuth, requireSeller } from '../sellers/sellers.auth.js';
import { createCreatorAuth, requireCreator } from './creators.auth.js';
import type { CreatorsRepository } from './creators.repository.js';
import type { SellersRepository } from '../sellers/sellers.repository.js';
import {
  CreateLinkSchema,
  CreatorSlugParamsSchema,
  RegisterCreatorSchema,
  UpdateMeSchema,
} from './creators.schemas.js';
import type { CreatorsService } from './creators.service.js';

export interface CreatorRouteDeps {
  service: CreatorsService;
  repo: CreatorsRepository;
  sellersRepo: SellersRepository;
  adminApiToken?: string | undefined;
}

const CampaignIdParams = z.object({ id: z.uuid() });

function campaignId(params: unknown): string {
  const parsed = CampaignIdParams.safeParse(params);
  if (!parsed.success) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');
  return parsed.data.id;
}

export function registerCreatorRoutes(app: FastifyInstance, deps: CreatorRouteDeps): void {
  const { service } = deps;

  // ---------- Platform operator: creator onboarding & profiles (PII + banking data) ----------
  void app.register(async (scope) => {
    scope.addHook('preHandler', createAdminAuth(deps.adminApiToken));
    scope.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    scope.post('/v1/creators', async (request, reply) => {
      const input = parseOrThrow(RegisterCreatorSchema, request.body);
      return reply.code(201).send(await service.register(input));
    });

    scope.get('/v1/creators/:slug', async (request) => {
      const parsed = CreatorSlugParamsSchema.safeParse(request.params);
      if (!parsed.success) throw new AppError(404, 'CREATOR_NOT_FOUND', 'Creator not found.');
      return service.getProfile(parsed.data.slug);
    });
  });

  // ---------- Creator self-service (creator API key) ----------
  // Static /v1/creators/me routes take precedence over the admin /v1/creators/:slug route.
  void app.register(async (scope) => {
    scope.addHook('preHandler', createCreatorAuth(deps.repo));
    scope.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    scope.get('/v1/creators/me', async (request) => service.me(requireCreator(request)));

    scope.patch('/v1/creators/me', async (request) =>
      service.updateMe(requireCreator(request), parseOrThrow(UpdateMeSchema, request.body)),
    );

    scope.get('/v1/creators/me/links', async (request) => service.myLinks(requireCreator(request)));

    scope.post('/v1/creators/me/rotate-api-key', async (request) => service.rotateMyApiKey(requireCreator(request)));
  });

  // ---------- Seller: link issuance for their own campaigns ----------
  // (Creator matching lives in the matchmaker module: GET /v1/campaigns/:id/matches.)
  void app.register(async (scope) => {
    scope.addHook('preHandler', createSellerAuth(deps.sellersRepo));

    scope.get('/v1/campaigns/:id/links', async (request) =>
      service.listLinks(requireSeller(request).id, campaignId(request.params)),
    );

    scope.post('/v1/campaigns/:id/links', async (request, reply) => {
      const id = campaignId(request.params);
      const input = parseOrThrow(CreateLinkSchema, request.body);
      return reply.code(201).send(await service.issueLink(requireSeller(request).id, id, input));
    });
  });
}
