import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import type { AntiFraudShield } from './anti-fraud-shield.js';
import type { CodeIssuanceService } from './code-issuance.service.js';
import { CodeRequestBodySchema } from './codes.schemas.js';

export function registerCodeRoutes(
  app: FastifyInstance,
  deps: { shield: AntiFraudShield; issuance: CodeIssuanceService },
): void {
  app.post('/v1/codes/request', async (request, reply) => {
    // Rate limit on the server-observed socket/proxy IP — never the client-supplied
    // `client_context.ip_address`, which an attacker could rotate freely. Runs before
    // body validation so malformed requests still count against the window.
    await deps.shield.enforceIpRateLimit(request.ip);

    const parsed = CodeRequestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request body.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const outcome = await deps.issuance.requestCode(parsed.data);

    reply.header('Cache-Control', 'no-store');
    if (outcome.kind === 'duplicate') {
      return reply.code(409).send({
        error: {
          code: 'ACTIVE_CODE_EXISTS',
          message: 'You already have an active code for this offer.',
        },
        existing_code: outcome.code,
      });
    }
    return reply.code(201).send({
      ...outcome.code,
      delivery: { whatsapp_backup: outcome.whatsappBackup },
    });
  });
}
