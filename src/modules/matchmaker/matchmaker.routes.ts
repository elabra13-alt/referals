import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INVITATION_STATUSES } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import { createCreatorAuth, requireCreator } from '../creators/creators.auth.js';
import type { CreatorsRepository } from '../creators/creators.repository.js';
import { MatchesQuerySchema } from '../creators/creators.schemas.js';
import { createSellerAuth, requireSeller } from '../sellers/sellers.auth.js';
import type { SellersRepository } from '../sellers/sellers.repository.js';
import type { InvitationsService } from './invitations.service.js';
import type { MatchmakerService } from './matchmaker.service.js';

const CampaignIdParams = z.object({ id: z.uuid() });
const InvitationIdParams = z.object({ id: z.uuid() });

const CreateInvitationSchema = z
  .object({
    creator_slug: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{3,16}$/)
      .transform((s) => s.toUpperCase()),
    custom_note: z
      .string()
      .trim()
      .max(500)
      .transform((v) => v || null)
      .nullish()
      .transform((v) => v ?? null),
  })
  .strict();

const InboxQuerySchema = z.object({
  status: z.enum([...INVITATION_STATUSES, 'all']).default('pending'),
});

function idFrom(params: unknown, schema: typeof CampaignIdParams, code: string, message: string): string {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new AppError(404, code, message);
  return parsed.data.id;
}

export function registerMatchmakerRoutes(
  app: FastifyInstance,
  deps: {
    matchmaker: MatchmakerService;
    invitations: InvitationsService;
    sellersRepo: SellersRepository;
    creatorsRepo: CreatorsRepository;
  },
): void {
  const campaignId = (params: unknown) => idFrom(params, CampaignIdParams, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');
  const invitationId = (params: unknown) => idFrom(params, InvitationIdParams, 'INVITATION_NOT_FOUND', 'Invitation not found.');

  // ---------- Seller: matchmaker + invitations for their own campaigns ----------
  void app.register(async (scope) => {
    scope.addHook('preHandler', createSellerAuth(deps.sellersRepo));

    scope.get('/v1/campaigns/:id/matches', async (request) => {
      const sellerId = requireSeller(request).id;
      const id = campaignId(request.params);
      const ranked = await deps.matchmaker.rankCreators(sellerId, id, parseOrThrow(MatchesQuerySchema, request.query));
      // Lets the dashboard disable "Invitar" before the seller hits a limit.
      return { ...ranked, quota: await deps.invitations.quotaFor(sellerId, id) };
    });

    scope.post('/v1/campaigns/:id/invitations', async (request, reply) => {
      const id = campaignId(request.params);
      const input = parseOrThrow(CreateInvitationSchema, request.body);
      return reply.code(201).send(await deps.invitations.invite(requireSeller(request).id, id, input));
    });

    scope.get('/v1/campaigns/:id/invitations', async (request) =>
      deps.invitations.listForCampaign(requireSeller(request).id, campaignId(request.params)),
    );
  });

  // ---------- Creator: inbox + 1-click accept / decline ----------
  void app.register(async (scope) => {
    scope.addHook('preHandler', createCreatorAuth(deps.creatorsRepo));
    scope.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    scope.get('/v1/creators/me/invitations', async (request) =>
      deps.invitations.inbox(requireCreator(request), parseOrThrow(InboxQuerySchema, request.query).status),
    );

    scope.post('/v1/creators/me/invitations/:id/accept', async (request, reply) => {
      const result = await deps.invitations.accept(requireCreator(request), invitationId(request.params));
      return reply.code(result.status === 'accepted' ? 201 : 200).send(result);
    });

    scope.post('/v1/creators/me/invitations/:id/decline', async (request) =>
      deps.invitations.decline(requireCreator(request), invitationId(request.params)),
    );
  });
}
