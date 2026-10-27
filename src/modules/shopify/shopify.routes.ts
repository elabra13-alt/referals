import type { FastifyInstance } from 'fastify';
import { parseOrThrow } from '../../lib/validation.js';
import { createSellerAuth, requireSeller } from '../sellers/sellers.auth.js';
import type { SellersRepository } from '../sellers/sellers.repository.js';
import { ShopifySetupSchema } from './shopify.schemas.js';
import type { ShopifyService } from './shopify.service.js';
import { SHOPIFY_HMAC_HEADER, SHOPIFY_SHOP_HEADER, SHOPIFY_TOPIC_HEADER, SHOPIFY_WEBHOOK_ID_HEADER } from './shopify.signature.js';

const header = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

export function registerShopifyRoutes(
  app: FastifyInstance,
  deps: { service: ShopifyService; sellersRepo: SellersRepository },
): void {
  // ---------- Native Shopify webhooks (HMAC over raw bytes) ----------
  void app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    // Shopify orders can be large (many line items); still bounded.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) =>
      done(null, body),
    );

    scope.post('/v1/webhooks/shopify', async (request, reply) => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const outcome = await deps.service.handleWebhook({
        shopDomain: header(request.headers[SHOPIFY_SHOP_HEADER]),
        topic: header(request.headers[SHOPIFY_TOPIC_HEADER]),
        hmac: header(request.headers[SHOPIFY_HMAC_HEADER]),
        webhookId: header(request.headers[SHOPIFY_WEBHOOK_ID_HEADER]),
        rawBody,
      });
      return reply.code(200).send(outcome);
    });
  });

  // ---------- Seller: connect / update their Shopify store ----------
  void app.register(async (scope) => {
    scope.addHook('preHandler', createSellerAuth(deps.sellersRepo));
    scope.patch('/v1/sellers/me/shopify', async (request, reply) => {
      const input = parseOrThrow(ShopifySetupSchema, request.body);
      reply.header('Cache-Control', 'no-store');
      return deps.service.configure(requireSeller(request).id, input);
    });
  });
}
