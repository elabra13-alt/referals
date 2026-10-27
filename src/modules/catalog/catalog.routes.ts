import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import { createCreatorAuth, requireCreator } from '../creators/creators.auth.js';
import type { CreatorsRepository } from '../creators/creators.repository.js';
import type { CatalogService } from './catalog.service.js';
import { CATALOG_CATEGORIES } from './hooks-generator.js';

const OpportunitiesQuerySchema = z.object({
  category: z.enum(CATALOG_CATEGORIES).optional(),
  /** Searches product name and brand (seller) name. */
  q: z
    .string()
    .trim()
    .max(80)
    .transform((v) => v || undefined)
    .optional(),
  sort: z.enum(['commission', 'commission_rate', 'newest']).default('commission'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

const CampaignIdParams = z.object({ campaignId: z.uuid() });

/**
 * Open Catalog. Creator-authenticated: listings include commission terms, which
 * are only shown to creators (never to anonymous visitors or competitors).
 */
export function registerCatalogRoutes(
  app: FastifyInstance,
  deps: { service: CatalogService; creatorsRepo: CreatorsRepository },
): void {
  void app.register(async (scope) => {
    scope.addHook('preHandler', createCreatorAuth(deps.creatorsRepo));
    scope.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    scope.get('/v1/catalog/opportunities', async (request) =>
      deps.service.listOpportunities(requireCreator(request), parseOrThrow(OpportunitiesQuerySchema, request.query)),
    );

    scope.post('/v1/catalog/opportunities/:campaignId/join', async (request, reply) => {
      const parsed = CampaignIdParams.safeParse(request.params);
      if (!parsed.success) throw new AppError(404, 'OPPORTUNITY_NOT_FOUND', 'This opportunity does not exist or is no longer open.');
      const result = await deps.service.join(requireCreator(request), parsed.data.campaignId);
      return reply.code(result.status === 'joined' ? 201 : 200).send(result);
    });
  });
}
