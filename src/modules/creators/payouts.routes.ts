import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateClabe } from '../../lib/clabe.js';
import { AppError } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import { createCreatorAuth, requireCreator } from './creators.auth.js';
import type { CreatorsRepository } from './creators.repository.js';
import type { PayoutsService } from './payouts.service.js';

/** 18-digit CLABE; spaces/dashes are stripped, then format + Modulo-10 control digit are checked. */
const ClabeInput = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .superRefine((v, ctx) => {
    const result = validateClabe(v);
    if (!result.isValid) ctx.addIssue({ code: 'custom', message: result.error });
  });

/**
 * RFC: 4 letters (individual) or 3 (company), birth/incorporation date YYMMDD,
 * 3-char homoclave. Uppercased; the date part must be a real calendar date.
 */
const RfcInput = z
  .string()
  .trim()
  .toUpperCase()
  .superRefine((v, ctx) => {
    const m = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z\d]{3})$/.exec(v);
    const month = m ? Number(m[3]) : 0;
    const day = m ? Number(m[4]) : 0;
    if (!m || month < 1 || month > 12 || day < 1 || day > 31) {
      ctx.addIssue({ code: 'custom', message: 'rfc must be a valid Mexican RFC (12 or 13 characters)' });
    }
  });

export const PayoutProfileSchema = z
  .object({
    clabe: ClabeInput,
    /** Account holder's full legal name, exactly as registered at the bank. */
    legal_name: z.string().trim().min(3).max(150),
    rfc: RfcInput.nullish().transform((v) => v ?? null),
  })
  .strict();

const WithdrawalSchema = z
  .object({
    /** Omit to withdraw the full available balance. */
    amount_cents: z.number().int().positive().max(100_000_000_00).optional(),
  })
  .strict();

const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, 'Idempotency-Key must be 8–100 letters, digits, - or _');

export function registerPayoutRoutes(
  app: FastifyInstance,
  deps: { service: PayoutsService; creatorsRepo: CreatorsRepository },
): void {
  void app.register(async (scope) => {
    scope.addHook('preHandler', createCreatorAuth(deps.creatorsRepo));
    scope.addHook('onSend', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    scope.get('/v1/creators/me/payout-profile', async (request) => deps.service.toProfileDto(requireCreator(request)));

    scope.put('/v1/creators/me/payout-profile', async (request) =>
      deps.service.updateProfile(requireCreator(request), parseOrThrow(PayoutProfileSchema, request.body)),
    );

    scope.get('/v1/creators/me/balance', async (request) => deps.service.balance(requireCreator(request)));

    scope.post('/v1/creators/me/withdrawals', async (request, reply) => {
      const body = parseOrThrow(WithdrawalSchema, request.body ?? {});
      const rawKey = request.headers['idempotency-key'];
      let idempotencyKey: string | null = null;
      if (rawKey !== undefined) {
        const parsed = IdempotencyKey.safeParse(rawKey);
        if (!parsed.success) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request.', {
            issues: [{ path: 'Idempotency-Key', message: parsed.error.issues[0]!.message }],
          });
        }
        idempotencyKey = parsed.data;
      }
      const { created, withdrawal } = await deps.service.requestWithdrawal(requireCreator(request), {
        amountCents: body.amount_cents !== undefined ? BigInt(body.amount_cents) : null,
        idempotencyKey,
      });
      return reply.code(created ? 201 : 200).send(withdrawal);
    });

    scope.get('/v1/creators/me/withdrawals', async (request) => deps.service.listWithdrawals(requireCreator(request)));
  });
}
