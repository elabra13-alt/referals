import type { FastifyBaseLogger } from 'fastify';
import { isUniqueViolation } from '../../db/client.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { decimalToCents } from '../../lib/money.js';
import { CODE_PATTERN } from '../codes/code-generator.js';
import type { DiscountProvisioner } from '../codes/discount-provisioner.js';
import type { OrderWebhookService, PaidResult, RefundResult } from '../webhooks/order-webhook.service.js';
import type { OrdersRepository } from '../webhooks/orders.repository.js';
import type { OrderPaidPayload } from '../webhooks/webhooks.schemas.js';
import { ShopifyApiError, type ShopifyClient, type ShopifyCredentials } from './shopify.client.js';
import type { ShopifyRepository, StoredShopifyConfig } from './shopify.repository.js';
import { ShopifyOrderSchema, ShopifyRefundSchema, type ShopifyOrder, type ShopifyRefund, type ShopifySetupInput } from './shopify.schemas.js';
import { verifyShopifyHmac } from './shopify.signature.js';

/** Distinct AAD per column: a ciphertext can't be swapped into another field. */
export const SHOPIFY_TOKEN_AAD = 'sellers.shopify_access_token';
export const SHOPIFY_WEBHOOK_SECRET_AAD = 'sellers.shopify_webhook_secret';

export const SUPPORTED_TOPICS = ['orders/paid', 'refunds/create'] as const;

export type ShopifyWebhookResult =
  | { topic: 'orders/paid'; result: PaidResult }
  | { topic: 'refunds/create'; result: RefundResult }
  | { topic: string; result: { status: 'ignored'; reason: string } };

const ignored = (topic: string, reason: string): ShopifyWebhookResult => ({ topic, result: { status: 'ignored', reason } });

const unauthorized = () => new AppError(401, 'INVALID_SIGNATURE', 'Shopify webhook verification failed.');
const shopTaken = () => new AppError(409, 'SHOPIFY_SHOP_TAKEN', 'This Shopify store is already connected to another seller.');

/**
 * Where Shopify should deliver webhooks. PUBLIC_API_URL wins; otherwise the
 * *origin* of PUBLIC_LINK_BASE_URL (its "/r" path is for buyer links, and
 * ".../r/v1/webhooks/shopify" would 404).
 */
export function shopifyWebhookCallbackUrl(opts: { publicApiUrl?: string | undefined; publicLinkBaseUrl: string }): string {
  const base = opts.publicApiUrl ? opts.publicApiUrl.replace(/\/+$/, '') : new URL(opts.publicLinkBaseUrl).origin;
  return `${base}/v1/webhooks/shopify`;
}

export interface ShopifyServiceDeps {
  repo: ShopifyRepository;
  client: ShopifyClient;
  orders: OrderWebhookService;
  ordersRepo: OrdersRepository;
  encryptionKey: Buffer;
  /** Public HTTPS URL of POST /v1/webhooks/shopify, registered with each connected store. */
  webhookCallbackUrl: string;
  log: FastifyBaseLogger;
}

/** Shopify decimal string -> integer cents, e.g. "1200.00" -> 120000n. */
const cents = (money: string) => decimalToCents(money);

/** Prefers a Referals code when a Shopify order carries several discount codes. */
export function pickReferalsCode(order: ShopifyOrder): string | null {
  const codes = order.discount_codes.map((c) => c.code.trim().toUpperCase()).filter(Boolean);
  return codes.find((c) => CODE_PATTERN.test(c)) ?? codes[0] ?? null;
}

/**
 * Maps a Shopify order onto the core `order.paid` contract.
 * Net = subtotal_price (after discounts, before shipping & taxes): commission is
 * paid on merchandise actually sold, not on shipping or tax.
 */
export function translateOrder(order: ShopifyOrder): OrderPaidPayload | { invalid: string } {
  const gross = cents(order.total_line_items_price);
  const discount = cents(order.total_discounts);
  const net = cents(order.subtotal_price);
  if (discount > gross || net > gross) return { invalid: 'inconsistent_totals' };
  const timestamp = new Date(order.processed_at ?? order.created_at);
  if (Number.isNaN(timestamp.getTime())) return { invalid: 'invalid_timestamp' };
  const email = (order.email ?? order.customer?.email ?? '').trim().toLowerCase() || null;

  return {
    event: 'order.paid',
    seller_order_id: order.id,
    applied_discount_code: pickReferalsCode(order),
    currency: order.currency,
    financials: { gross_total: gross, discount_total: discount, net_total: net },
    customer: { email },
    timestamp,
  };
}

/** Money actually returned to the customer in this refund. */
export function refundedCents(refund: ShopifyRefund): bigint {
  return refund.transactions
    .filter((t) => t.kind === 'refund' && (t.status ?? 'success') === 'success')
    .reduce((sum, t) => sum + cents(t.amount), 0n);
}

export class ShopifyService {
  constructor(private readonly deps: ShopifyServiceDeps) {}

  // ---------- Seller setup ----------

  /** Validates the credentials against Shopify, then stores them encrypted. */
  async configure(sellerId: string, input: ShopifySetupInput) {
    const shop = await this.deps.client
      .getShop({ shopDomain: input.shop_domain, accessToken: input.access_token })
      .catch((err: unknown) => {
        this.deps.log.warn({ err, shopDomain: input.shop_domain }, 'shopify credential check failed');
        throw new AppError(422, 'SHOPIFY_CREDENTIALS_INVALID', 'Shopify rejected these credentials or the shop is unreachable.');
      });
    if (shop.myshopifyDomain.toLowerCase() !== input.shop_domain) {
      throw new AppError(422, 'SHOPIFY_CREDENTIALS_INVALID', 'The access token belongs to a different shop.');
    }

    // Check ownership before touching the store, so another seller's shop never gets our subscriptions.
    const owner = await this.deps.repo.findByShopDomain(input.shop_domain);
    if (owner && owner.sellerId !== sellerId) throw shopTaken();

    // Register before saving: a store is only "connected" once Shopify will actually deliver orders to us.
    const webhookSubscriptionIds = await this.deps.client
      .registerWebhooks({ shopDomain: input.shop_domain, accessToken: input.access_token }, this.deps.webhookCallbackUrl)
      .catch((err: unknown) => {
        this.deps.log.error(
          { err, shopDomain: input.shop_domain, callbackUrl: this.deps.webhookCallbackUrl },
          'shopify webhook registration failed',
        );
        const userErrors = err instanceof ShopifyApiError ? (err.userErrors ?? []) : [];
        if (userErrors.length > 0) {
          throw new AppError(422, 'SHOPIFY_WEBHOOK_REGISTRATION_FAILED', 'Shopify refused the webhook subscriptions.', {
            messages: userErrors.map((e) => e.message),
          });
        }
        throw new AppError(502, 'SHOPIFY_UNAVAILABLE', 'Could not reach Shopify to register webhooks. Please retry.', undefined, {
          'Retry-After': '5',
        });
      });

    try {
      await this.deps.repo.save(sellerId, {
        shopDomain: input.shop_domain,
        encryptedAccessToken: encryptSecret(input.access_token, this.deps.encryptionKey, SHOPIFY_TOKEN_AAD),
        encryptedWebhookSecret: encryptSecret(input.webhook_secret, this.deps.encryptionKey, SHOPIFY_WEBHOOK_SECRET_AAD),
        discountPercentage: input.discount_percentage,
      });
    } catch (err) {
      if (isUniqueViolation(err, 'sellers_shopify_shop_domain_unique')) throw shopTaken();
      throw err;
    }

    return {
      shop_domain: input.shop_domain,
      shop_name: shop.name,
      discount_percentage: input.discount_percentage,
      connected: true as const,
      webhook_topics: [...SUPPORTED_TOPICS],
      webhook_callback_url: this.deps.webhookCallbackUrl,
      webhook_subscription_ids: webhookSubscriptionIds,
    };
  }

  credentialsFor(config: StoredShopifyConfig): ShopifyCredentials {
    return {
      shopDomain: config.shopDomain,
      accessToken: decryptSecret(config.encryptedAccessToken, this.deps.encryptionKey, SHOPIFY_TOKEN_AAD),
    };
  }

  // ---------- Webhooks ----------

  /**
   * Verifies and dispatches one Shopify webhook. Signature problems are 401s;
   * payloads we can't use are acknowledged (200, "ignored") because Shopify
   * retries non-2xx responses and eventually deletes failing subscriptions.
   */
  async handleWebhook(input: {
    shopDomain: string | undefined;
    topic: string | undefined;
    hmac: string | undefined;
    rawBody: Buffer;
    webhookId?: string | undefined;
  }): Promise<ShopifyWebhookResult> {
    const { log } = this.deps;
    const shopDomain = input.shopDomain?.trim().toLowerCase();
    if (!shopDomain) throw unauthorized();

    const config = await this.deps.repo.findByShopDomain(shopDomain);
    if (!config || config.sellerStatus !== 'active') throw unauthorized();

    let secret: string;
    try {
      secret = decryptSecret(config.encryptedWebhookSecret, this.deps.encryptionKey, SHOPIFY_WEBHOOK_SECRET_AAD);
    } catch (err) {
      log.error({ err, sellerId: config.sellerId }, 'failed to decrypt shopify webhook secret');
      throw unauthorized();
    }
    if (!verifyShopifyHmac(input.rawBody, input.hmac, secret)) throw unauthorized();

    const topic = input.topic ?? '';
    let json: unknown;
    try {
      json = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      log.warn({ shopDomain, topic, webhookId: input.webhookId }, 'shopify webhook body is not JSON');
      return ignored(topic, 'invalid_json');
    }

    if (topic === 'orders/paid') return this.handleOrderPaid(config.sellerId, json, input.webhookId);
    if (topic === 'refunds/create') return this.handleRefund(config.sellerId, json, input.webhookId);
    return ignored(topic, 'unsupported_topic');
  }

  private async handleOrderPaid(sellerId: string, json: unknown, webhookId?: string): Promise<ShopifyWebhookResult> {
    const parsed = ShopifyOrderSchema.safeParse(json);
    if (!parsed.success) {
      this.deps.log.warn({ sellerId, webhookId, issues: parsed.error.issues }, 'unusable shopify order payload');
      return ignored('orders/paid', 'invalid_payload');
    }
    const payload = translateOrder(parsed.data);
    if ('invalid' in payload) {
      this.deps.log.warn({ sellerId, webhookId, orderId: parsed.data.id, reason: payload.invalid }, 'unusable shopify order');
      return ignored('orders/paid', payload.invalid);
    }
    return { topic: 'orders/paid', result: await this.deps.orders.processPaid(sellerId, payload) };
  }

  /**
   * Only a refund that returns at least the order's net merchandise total
   * reverses the commission. Partial refunds are acknowledged and logged for
   * review: proportional commission adjustment isn't supported yet.
   */
  private async handleRefund(sellerId: string, json: unknown, webhookId?: string): Promise<ShopifyWebhookResult> {
    const { log } = this.deps;
    const parsed = ShopifyRefundSchema.safeParse(json);
    if (!parsed.success) {
      log.warn({ sellerId, webhookId, issues: parsed.error.issues }, 'unusable shopify refund payload');
      return ignored('refunds/create', 'invalid_payload');
    }
    const refund = parsed.data;

    const amount = refundedCents(refund);
    if (amount === 0n) return ignored('refunds/create', 'no_refunded_amount');

    const sale = await this.deps.ordersRepo.findSaleByOrder(sellerId, refund.order_id);
    if (!sale) {
      log.warn({ sellerId, orderId: refund.order_id, refundId: refund.id }, 'shopify refund for unknown order');
      return ignored('refunds/create', 'sale_not_found');
    }
    if (amount < decimalToCents(sale.netTotal)) {
      log.warn(
        { sellerId, saleId: sale.id, refundId: refund.id, refundedCents: String(amount), netTotal: sale.netTotal },
        'partial shopify refund not applied to commission; needs review',
      );
      return ignored('refunds/create', 'partial_refund');
    }

    const result = await this.deps.orders.processRefund(sellerId, {
      event: 'order.refunded',
      seller_order_id: refund.order_id,
      reason: `shopify refund ${refund.id}`,
      timestamp: new Date(refund.created_at),
    });
    return { topic: 'refunds/create', result };
  }
}

/** Creates each issued code in the seller's Shopify store; no-op for sellers without Shopify. */
export class ShopifyDiscountProvisioner implements DiscountProvisioner {
  constructor(
    private readonly deps: { repo: ShopifyRepository; client: ShopifyClient; service: ShopifyService },
  ) {}

  async provision(input: { sellerId: string; code: string; issuedAt: Date; expiresAt: Date }): Promise<void> {
    const config = await this.deps.repo.findBySellerId(input.sellerId);
    if (!config) return;
    try {
      await this.deps.client.createSingleUseDiscount(this.deps.service.credentialsFor(config), {
        code: input.code,
        title: `Referals ${input.code}`,
        percentage: config.discountPercentage,
        startsAt: input.issuedAt,
        endsAt: input.expiresAt,
      });
    } catch (err) {
      if (err instanceof ShopifyApiError) throw err;
      throw new ShopifyApiError(`Shopify provisioning failed: ${(err as Error).message}`);
    }
  }
}
