import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Database } from './db/client.js';
import { AppError } from './lib/errors.js';
import type { RedisClient } from './lib/redis.js';
import { AntiFraudShield, type AntiFraudShieldOptions } from './modules/codes/anti-fraud-shield.js';
import { LoggingBackupDelivery, type BackupDelivery } from './modules/codes/backup-delivery.js';
import { CodeGenerator, type CodeGeneratorOptions } from './modules/codes/code-generator.js';
import { CodeIssuanceService } from './modules/codes/code-issuance.service.js';
import { DrizzleCodesRepository } from './modules/codes/codes.repository.js';
import { registerCodeRoutes } from './modules/codes/codes.routes.js';
import { OrderWebhookService } from './modules/webhooks/order-webhook.service.js';
import { OrdersRepository } from './modules/webhooks/orders.repository.js';
import { registerWebhookRoutes } from './modules/webhooks/webhooks.routes.js';
import { SellersRepository } from './modules/sellers/sellers.repository.js';
import { registerSellerRoutes } from './modules/sellers/sellers.routes.js';
import { SellersService } from './modules/sellers/sellers.service.js';
import { CreatorsRepository } from './modules/creators/creators.repository.js';
import { registerCreatorRoutes } from './modules/creators/creators.routes.js';
import { CreatorsService } from './modules/creators/creators.service.js';
import { MatchingService } from './modules/creators/matching.service.js';
import {
  GeminiScriptGenerator,
  TemplateScriptGenerator,
  type ScriptGenerator,
} from './modules/creators/script-generator.service.js';
import { LinksRepository } from './modules/links/links.repository.js';
import { registerLinkRoutes } from './modules/links/links.routes.js';
import { LinksService } from './modules/links/links.service.js';
import { StorefrontService } from './modules/storefront/coupon.service.js';
import { StorefrontRepository } from './modules/storefront/storefront.repository.js';
import { registerStorefrontRoutes } from './modules/storefront/storefront.routes.js';
import { CatalogRepository } from './modules/catalog/catalog.repository.js';
import { registerCatalogRoutes } from './modules/catalog/catalog.routes.js';
import { CatalogService } from './modules/catalog/catalog.service.js';
import { HooksGenerator } from './modules/catalog/hooks-generator.js';
import { CampaignEnrollment } from './modules/catalog/enrollment.js';
import { InvitationsRepository } from './modules/matchmaker/invitations.repository.js';
import { InvitationsService } from './modules/matchmaker/invitations.service.js';
import { registerMatchmakerRoutes } from './modules/matchmaker/matchmaker.routes.js';
import { MatchmakerService } from './modules/matchmaker/matchmaker.service.js';
import { registerInvitationUiRoutes } from './modules/creators/invitations-ui.routes.js';
import { MagicSessions } from './modules/creators/magic-link.js';
import { registerPortalAuthRoutes } from './modules/creators/portal-auth.routes.js';
import { PortalAuthService } from './modules/creators/portal-auth.service.js';
import { registerPortalUiRoutes } from './modules/creators/portal-ui.routes.js';
import { registerPayoutRoutes } from './modules/creators/payouts.routes.js';
import { PayoutsService } from './modules/creators/payouts.service.js';
import {
  LoggingWhatsAppProvider,
  MetaCloudWhatsAppProvider,
  WhatsAppNotificationService,
  type WhatsAppProvider,
} from './modules/notifications/whatsapp.service.js';
import { HttpShopifyClient, type ShopifyClient } from './modules/shopify/shopify.client.js';
import { ShopifyRepository } from './modules/shopify/shopify.repository.js';
import { registerShopifyRoutes } from './modules/shopify/shopify.routes.js';
import { ShopifyDiscountProvisioner, ShopifyService, shopifyWebhookCallbackUrl } from './modules/shopify/shopify.service.js';

export interface AppDeps {
  db: Database;
  redis: RedisClient;
  /** AES-256-GCM key for seller webhook secrets at rest (32 bytes). */
  webhookEncryptionKey: Buffer;
  /** Platform-operator token for seller/creator onboarding; those endpoints are disabled when unset. */
  adminApiToken?: string | undefined;
  /** Public base for creator links, e.g. https://referals.mx/r -> https://referals.mx/r/leo-glow-serum */
  publicLinkBaseUrl?: string;
  /** Overrides the script engine entirely (tests). Otherwise Gemini when a key is set, else the template. */
  scriptGenerator?: ScriptGenerator;
  geminiApiKey?: string | undefined;
  geminiModel?: string | undefined;
  /** Overrides the WhatsApp transport (tests use InMemoryWhatsAppOutbox). */
  whatsappProvider?: WhatsAppProvider;
  whatsapp?: { accessToken: string; phoneNumberId: string; apiVersion?: string } | undefined;
  /** Origin serving the creator invitation pages (/c/invitations/:id); defaults to the link domain's origin. */
  creatorAppUrl?: string | undefined;
  /** Shopify Admin API client; defaults to the real HTTP client. */
  shopifyClient?: ShopifyClient;
  shopifyApiVersion?: string;
  /** Public base URL of this API (e.g. https://api.referals.mx); used for Shopify webhook callbacks. */
  publicApiUrl?: string | undefined;
  backupDelivery?: (log: FastifyBaseLogger) => BackupDelivery;
  generatorOptions?: CodeGeneratorOptions;
  shieldOptions?: AntiFraudShieldOptions;
  now?: () => Date;
}

export const DEFAULT_PUBLIC_LINK_BASE_URL = 'https://referals.mx/r';

export function buildApp(deps: AppDeps, fastifyOptions: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ bodyLimit: 16 * 1024, ...fastifyOptions });

  const ordersRepo = new OrdersRepository(deps.db);
  const orderWebhooks = new OrderWebhookService({
    repo: ordersRepo,
    redis: deps.redis,
    log: app.log,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const shopifyRepo = new ShopifyRepository(deps.db);
  const shopifyClient = deps.shopifyClient ?? new HttpShopifyClient({ ...(deps.shopifyApiVersion ? { apiVersion: deps.shopifyApiVersion } : {}) });
  const shopifyService = new ShopifyService({
    repo: shopifyRepo,
    client: shopifyClient,
    orders: orderWebhooks,
    ordersRepo,
    encryptionKey: deps.webhookEncryptionKey,
    webhookCallbackUrl: shopifyWebhookCallbackUrl({
      publicApiUrl: deps.publicApiUrl,
      publicLinkBaseUrl: deps.publicLinkBaseUrl ?? DEFAULT_PUBLIC_LINK_BASE_URL,
    }),
    log: app.log,
  });

  const shield = new AntiFraudShield(deps.redis, deps.shieldOptions);
  const issuance = new CodeIssuanceService({
    repo: new DrizzleCodesRepository(deps.db),
    shield,
    generator: new CodeGenerator(deps.generatorOptions),
    backupDelivery: deps.backupDelivery?.(app.log) ?? new LoggingBackupDelivery(app.log),
    discountProvisioner: new ShopifyDiscountProvisioner({ repo: shopifyRepo, client: shopifyClient, service: shopifyService }),
    log: app.log,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const sellersRepo = new SellersRepository(deps.db);
  const sellersService = new SellersService(sellersRepo, deps.webhookEncryptionKey);

  const creatorsRepo = new CreatorsRepository(deps.db);
  const scriptGenerator =
    deps.scriptGenerator ??
    (deps.geminiApiKey
      ? new GeminiScriptGenerator({ apiKey: deps.geminiApiKey, model: deps.geminiModel, log: app.log })
      : new TemplateScriptGenerator());
  const publicLinkBaseUrl = deps.publicLinkBaseUrl ?? DEFAULT_PUBLIC_LINK_BASE_URL;
  const matching = new MatchingService();
  const creatorsService = new CreatorsService({
    db: deps.db,
    repo: creatorsRepo,
    sellersRepo,
    matching,
    scripts: scriptGenerator,
    publicLinkBaseUrl,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const linksService = new LinksService(new LinksRepository(deps.db), deps.now);

  // Populated by the auth preHandlers (sellers.auth.ts / creators.auth.ts) on authenticated routes.
  app.decorateRequest('seller', null);
  app.decorateRequest('creator', null);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof AppError) {
      if (err.headers) reply.headers(err.headers);
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    // Fastify's own 4xx (malformed JSON, payload too large, wrong content type…).
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  registerCodeRoutes(app, { shield, issuance });
  registerLinkRoutes(app, { service: linksService });
  const enrollment = new CampaignEnrollment({ db: deps.db, creatorsRepo, scripts: scriptGenerator, publicLinkBaseUrl });
  const hooks = new HooksGenerator();
  const invitationsRepo = new InvitationsRepository(deps.db);
  const matchmaker = new MatchmakerService({
    sellersRepo,
    creatorsRepo,
    invitationsRepo,
    matching,
    ...(deps.now ? { now: deps.now } : {}),
  });
  // Origin serving the creator pages (/c/invitations, /c/login and the portal).
  const creatorAppOrigin = (deps.creatorAppUrl ?? new URL(publicLinkBaseUrl).origin).replace(/\/+$/, '');
  const whatsapp = new WhatsAppNotificationService({
    provider:
      deps.whatsappProvider ??
      (deps.whatsapp ? new MetaCloudWhatsAppProvider(deps.whatsapp) : new LoggingWhatsAppProvider(app.log)),
    log: app.log,
    invitationReviewBaseUrl: `${creatorAppOrigin}/c/invitations`,
  });
  const invitations = new InvitationsService({
    db: deps.db,
    whatsapp,
    repo: invitationsRepo,
    matchmaker,
    creatorsRepo,
    enrollment,
    hooks,
    publicLinkBaseUrl,
  });
  registerMatchmakerRoutes(app, { matchmaker, invitations, sellersRepo, creatorsRepo });
  // Session signing key is HKDF-derived from the master key, never the key itself.
  const sessions = new MagicSessions(deps.webhookEncryptionKey);
  registerInvitationUiRoutes(app, { invitations, sessions, ...(deps.now ? { now: deps.now } : {}) });
  const payouts = new PayoutsService({ db: deps.db, creatorsRepo, ...(deps.now ? { now: deps.now } : {}) });
  registerPayoutRoutes(app, { service: payouts, creatorsRepo });
  registerCatalogRoutes(app, {
    service: new CatalogService({
      repo: new CatalogRepository(deps.db),
      enrollment,
      hooks,
      publicLinkBaseUrl,
    }),
    creatorsRepo,
  });
  const storefront = new StorefrontService({
    repo: new StorefrontRepository(deps.db),
    issuance,
    ...(deps.now ? { now: deps.now } : {}),
  });
  registerStorefrontRoutes(app, { service: storefront, shield, creatorsRepo });
  registerPortalUiRoutes(app, {
    creatorsRepo,
    payouts,
    storefront,
    invitations,
    hooks,
    sessions,
    publicLinkBaseUrl,
    ...(deps.now ? { now: deps.now } : {}),
  });
  registerPortalAuthRoutes(app, {
    auth: new PortalAuthService({
      db: deps.db,
      redis: deps.redis,
      whatsapp,
      loginVerifyUrl: `${creatorAppOrigin}/c/login/verify`,
      log: app.log,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    creatorsRepo,
    sessions,
    ...(deps.now ? { now: deps.now } : {}),
  });
  registerSellerRoutes(app, { repo: sellersRepo, service: sellersService, adminApiToken: deps.adminApiToken });
  registerCreatorRoutes(app, { service: creatorsService, repo: creatorsRepo, sellersRepo, adminApiToken: deps.adminApiToken });
  registerShopifyRoutes(app, { service: shopifyService, sellersRepo });
  registerWebhookRoutes(app, { repo: ordersRepo, service: orderWebhooks, encryptionKey: deps.webhookEncryptionKey });

  return app;
}
