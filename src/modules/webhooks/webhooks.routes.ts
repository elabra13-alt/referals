import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import type { OrderWebhookService } from './order-webhook.service.js';
import type { OrdersRepository } from './orders.repository.js';
import { SELLER_ID_HEADER, SIGNATURE_HEADER, resolveStoredSecret, verifySignature } from './signature.js';
import { OrderPaidSchema, OrderRefundedSchema } from './webhooks.schemas.js';

const SellerIdSchema = z.uuid();

/** Same response for every auth failure so callers can't probe which seller ids exist. */
const unauthorized = () => new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature verification failed.');

/** Authenticates the seller from the raw bytes, then parses + validates the JSON body. */
async function authenticateAndParse<S extends z.ZodType>(
  request: FastifyRequest,
  deps: WebhookRouteDeps,
  schema: S,
): Promise<{ sellerId: string; payload: z.output<S> }> {
  const sellerIdHeader = request.headers[SELLER_ID_HEADER];
  const signature = request.headers[SIGNATURE_HEADER];
  const sellerId = SellerIdSchema.safeParse(sellerIdHeader);
  if (!sellerId.success || typeof signature !== 'string') throw unauthorized();

  const seller = await deps.repo.findSeller(sellerId.data);
  const rawBody = request.body;
  if (!seller || seller.status !== 'active' || !Buffer.isBuffer(rawBody)) throw unauthorized();

  const secret = resolveStoredSecret(seller.webhookSecret, deps.encryptionKey);
  if (!secret.ok) {
    // Wrong key or tampered ciphertext: an ops problem, but still a 401 to the caller.
    request.log.error({ err: secret.error, sellerId: seller.id }, 'failed to decrypt seller webhook secret');
    throw unauthorized();
  }
  if (secret.legacyPlaintext) {
    request.log.warn({ sellerId: seller.id }, 'seller webhook secret stored in plaintext; run db:encrypt-secrets');
  }
  if (!verifySignature(rawBody, signature, secret.secret)) throw unauthorized();

  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid webhook payload.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return { sellerId: seller.id, payload: parsed.data };
}

export interface WebhookRouteDeps {
  repo: OrdersRepository;
  service: OrderWebhookService;
  /** AES-256-GCM key that seller webhook secrets are encrypted with at rest. */
  encryptionKey: Buffer;
}

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  void app.register(async (scope) => {
    // HMAC must be computed over the exact bytes received, so keep JSON bodies raw in this scope.
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 64 * 1024 }, (_req, body, done) =>
      done(null, body),
    );

    scope.post('/v1/webhooks/orders/paid', async (request, reply) => {
      const { sellerId, payload } = await authenticateAndParse(request, deps, OrderPaidSchema);
      const result = await deps.service.processPaid(sellerId, payload);
      return reply.code(result.status === 'processed' ? 201 : 200).send(result);
    });

    scope.post('/v1/webhooks/orders/refunded', async (request, reply) => {
      const { sellerId, payload } = await authenticateAndParse(request, deps, OrderRefundedSchema);
      return reply.code(200).send(await deps.service.processRefund(sellerId, payload));
    });
  });
}
