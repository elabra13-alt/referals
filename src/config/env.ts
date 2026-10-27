import 'dotenv/config';
import { z } from 'zod';
import { parseEncryptionKey } from '../lib/crypto.js';
import { DEFAULT_GEMINI_MODEL } from '../modules/creators/gemini-script-generator.js';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  /** "true", "false", or a comma-separated list of trusted proxy IPs/CIDRs. */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v): boolean | string[] =>
      v === 'true' ? true : v === 'false' ? false : v.split(',').map((s) => s.trim()).filter(Boolean),
    ),
  /**
   * AES-256-GCM key for seller webhook secrets: 64 hex chars, or a passphrase of 32+ chars.
   * Empty counts as unset (`.env.example` ships `WEBHOOK_ENCRYPTION_KEY=`).
   */
  WEBHOOK_ENCRYPTION_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Platform-operator token for POST /v1/sellers. Onboarding is disabled when unset. */
  ADMIN_API_TOKEN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32, 'ADMIN_API_TOKEN must be at least 32 chars').optional(),
  ),
  /** Enables live AI scripts via Gemini. Unset/empty = deterministic template scripts. */
  GEMINI_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  /** Gemini 1.5/2.0 are shut down; see https://ai.google.dev/gemini-api/docs/models. */
  GEMINI_MODEL: z.string().min(1).default(DEFAULT_GEMINI_MODEL),
  /** WhatsApp Business Cloud API. Both unset = notifications are logged, not sent. */
  WHATSAPP_ACCESS_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  WHATSAPP_PHONE_NUMBER_ID: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d+$/).optional()),
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  /** Creator-facing app; invitation links point to <CREATOR_APP_URL>/invitaciones/<id>. */
  CREATOR_APP_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  /** Shopify Admin GraphQL API version (Shopify retires versions after ~12 months). */
  SHOPIFY_API_VERSION: z.string().regex(/^\d{4}-\d{2}$/).default('2026-10'),
  /**
   * Public base URL of this API, e.g. https://api.referals.mx. Shopify webhooks are
   * registered at <PUBLIC_API_URL>/v1/webhooks/shopify; when unset, the origin of
   * PUBLIC_LINK_BASE_URL is used. Must be publicly reachable over HTTPS.
   */
  PUBLIC_API_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
  /** Public base URL that creator links are served under. */
  PUBLIC_LINK_BASE_URL: z.url().default('https://referals.mx/r'),
  ESCROW_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  ESCROW_WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(5_000).default(500),
});

/** Insecure, publicly known key — only ever used outside production. */
const DEV_FALLBACK_ENCRYPTION_KEY = 'referals-dev-only-insecure-webhook-encryption-key';

export type Env = Omit<z.infer<typeof EnvSchema>, 'WEBHOOK_ENCRYPTION_KEY'> & { WEBHOOK_ENCRYPTION_KEY: Buffer };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const { WEBHOOK_ENCRYPTION_KEY: rawKey, ...rest } = parsed.data;
  if (!rawKey && rest.NODE_ENV === 'production') {
    throw new Error('Invalid environment configuration:\nWEBHOOK_ENCRYPTION_KEY is required in production');
  }
  let key: Buffer;
  try {
    key = parseEncryptionKey(rawKey ?? DEV_FALLBACK_ENCRYPTION_KEY);
  } catch (err) {
    throw new Error(`Invalid environment configuration:\nWEBHOOK_ENCRYPTION_KEY: ${(err as Error).message}`);
  }
  if (Boolean(rest.WHATSAPP_ACCESS_TOKEN) !== Boolean(rest.WHATSAPP_PHONE_NUMBER_ID)) {
    throw new Error('Invalid environment configuration:\nWHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID must be set together');
  }
  return { ...rest, WEBHOOK_ENCRYPTION_KEY: key };
}
