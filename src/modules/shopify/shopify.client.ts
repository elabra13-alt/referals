/**
 * Minimal Shopify Admin GraphQL client: just what Referals needs.
 * The interface is the seam tests mock; `HttpShopifyClient` is the real one.
 */

export const DEFAULT_SHOPIFY_API_VERSION = '2026-10';
/** Must stay well under the 5s coupon-issuance lock TTL. */
const DEFAULT_TIMEOUT_MS = 3_000;

export interface ShopifyCredentials {
  shopDomain: string;
  accessToken: string;
}

export interface SingleUseDiscountInput {
  code: string;
  title: string;
  /** e.g. "10.00" (percent). Sent to Shopify as a 0–1 fraction. */
  percentage: string;
  startsAt: Date;
  endsAt: Date;
}

export interface ShopifyClient {
  /** Cheap authenticated call used to validate credentials at setup time. */
  getShop(creds: ShopifyCredentials): Promise<{ name: string; myshopifyDomain: string }>;
  /** Creates a code usable once, by one customer, until `endsAt`. Returns the discount node GID. */
  createSingleUseDiscount(creds: ShopifyCredentials, input: SingleUseDiscountInput): Promise<{ id: string }>;
  /**
   * Ensures ORDERS_PAID and REFUNDS_CREATE subscriptions deliver to `callbackUrl`.
   * Idempotent: subscriptions that already exist are reused, not duplicated.
   * Returns subscription GIDs in REFERALS_WEBHOOK_TOPICS order.
   */
  registerWebhooks(creds: ShopifyCredentials, callbackUrl: string): Promise<string[]>;
}

/** GraphQL enum values for the topics Referals consumes (delivered as orders/paid, refunds/create). */
export const REFERALS_WEBHOOK_TOPICS = ['ORDERS_PAID', 'REFUNDS_CREATE'] as const;
export type ReferalsWebhookTopic = (typeof REFERALS_WEBHOOK_TOPICS)[number];

export class ShopifyApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly userErrors?: { field?: string[] | null; message: string }[],
  ) {
    super(message);
    this.name = 'ShopifyApiError';
  }
}

const SHOP_QUERY = `query { shop { name myshopifyDomain } }`;

const DISCOUNT_CODE_BASIC_CREATE = `
mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field message }
  }
}`;

const WEBHOOK_SUBSCRIPTIONS_QUERY = `
query referalsWebhooks($topics: [WebhookSubscriptionTopic!], $uri: String) {
  webhookSubscriptions(first: 50, topics: $topics, uri: $uri) {
    edges { node { id topic uri } }
  }
}`;

/** Since 2025 the destination is `uri` (`callbackUrl` is deprecated). */
const WEBHOOK_SUBSCRIPTION_CREATE = `
mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    userErrors { field message }
    webhookSubscription { id topic }
  }
}`;

/** "10.00" -> 0.1 (Shopify expects percentages as fractions). */
export function percentageToFraction(percentage: string): number {
  return Math.round(Number(percentage) * 100) / 10_000;
}

export class HttpShopifyClient implements ShopifyClient {
  constructor(
    private readonly opts: {
      apiVersion?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    } = {},
  ) {}

  private async graphql<T>(creds: ShopifyCredentials, query: string, variables?: Record<string, unknown>): Promise<T> {
    const doFetch = this.opts.fetch ?? fetch;
    const version = this.opts.apiVersion ?? DEFAULT_SHOPIFY_API_VERSION;
    let res: Response;
    try {
      res = await doFetch(`https://${creds.shopDomain}/admin/api/${version}/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': creds.accessToken },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ShopifyApiError(`Shopify request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ShopifyApiError(`Shopify responded ${res.status}`, res.status);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new ShopifyApiError(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
    if (!body.data) throw new ShopifyApiError('Shopify returned no data');
    return body.data;
  }

  async getShop(creds: ShopifyCredentials): Promise<{ name: string; myshopifyDomain: string }> {
    const data = await this.graphql<{ shop: { name: string; myshopifyDomain: string } }>(creds, SHOP_QUERY);
    return data.shop;
  }

  async createSingleUseDiscount(creds: ShopifyCredentials, input: SingleUseDiscountInput): Promise<{ id: string }> {
    const data = await this.graphql<{
      discountCodeBasicCreate: {
        codeDiscountNode: { id: string } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(creds, DISCOUNT_CODE_BASIC_CREATE, {
      basicCodeDiscount: {
        title: input.title,
        code: input.code,
        startsAt: input.startsAt.toISOString(),
        endsAt: input.endsAt.toISOString(),
        usageLimit: 1,
        appliesOncePerCustomer: true,
        customerSelection: { all: true },
        customerGets: { value: { percentage: percentageToFraction(input.percentage) }, items: { all: true } },
      },
    });
    const result = data.discountCodeBasicCreate;
    if (result.userErrors.length > 0 || !result.codeDiscountNode) {
      throw new ShopifyApiError(
        `Shopify rejected discount ${input.code}: ${result.userErrors.map((e) => e.message).join('; ') || 'no node returned'}`,
        undefined,
        result.userErrors,
      );
    }
    return { id: result.codeDiscountNode.id };
  }

  /** Existing subscriptions of ours, keyed by topic. */
  private async existingWebhooks(creds: ShopifyCredentials, callbackUrl: string): Promise<Map<string, string>> {
    const data = await this.graphql<{
      webhookSubscriptions: { edges: { node: { id: string; topic: string; uri: string | null } }[] };
    }>(creds, WEBHOOK_SUBSCRIPTIONS_QUERY, { topics: [...REFERALS_WEBHOOK_TOPICS], uri: callbackUrl });
    const byTopic = new Map<string, string>();
    for (const { node } of data.webhookSubscriptions.edges) {
      // Filter client-side too: never adopt a subscription pointing somewhere else.
      if (node.uri === callbackUrl && !byTopic.has(node.topic)) byTopic.set(node.topic, node.id);
    }
    return byTopic;
  }

  async registerWebhooks(creds: ShopifyCredentials, callbackUrl: string): Promise<string[]> {
    const existing = await this.existingWebhooks(creds, callbackUrl);

    for (const topic of REFERALS_WEBHOOK_TOPICS) {
      if (existing.has(topic)) continue;
      const data = await this.graphql<{
        webhookSubscriptionCreate: {
          userErrors: { field: string[] | null; message: string }[];
          webhookSubscription: { id: string; topic: string } | null;
        };
      }>(creds, WEBHOOK_SUBSCRIPTION_CREATE, { topic, webhookSubscription: { uri: callbackUrl } });
      const result = data.webhookSubscriptionCreate;

      if (result.webhookSubscription) {
        existing.set(topic, result.webhookSubscription.id);
        continue;
      }
      // Created concurrently (e.g. a double-submitted setup): Shopify reports the address as taken.
      if (result.userErrors.some((e) => /taken|already/i.test(e.message))) {
        const id = (await this.existingWebhooks(creds, callbackUrl)).get(topic);
        if (id) {
          existing.set(topic, id);
          continue;
        }
      }
      throw new ShopifyApiError(
        `Shopify rejected webhook ${topic}: ${result.userErrors.map((e) => e.message).join('; ') || 'no subscription returned'}`,
        undefined,
        result.userErrors,
      );
    }

    return REFERALS_WEBHOOK_TOPICS.map((t) => existing.get(t)!);
  }
}
