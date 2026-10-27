import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX = 'ref_live_';
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

const KEY_ENTROPY_BYTES = 32;
/** base64url of 32 bytes is exactly 43 chars. */
const API_KEY_PATTERN = /^ref_live_[A-Za-z0-9_-]{43}$/;

/** `ref_live_<43 base64url chars>` — 256 bits of entropy. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(KEY_ENTROPY_BYTES).toString('base64url')}`;
}

/** `whsec_<43 base64url chars>` — the seller's HMAC signing secret. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(KEY_ENTROPY_BYTES).toString('base64url')}`;
}

export function isWellFormedApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

export const CREATOR_API_KEY_PREFIX = 'cr_live_';
/** base64url of 24 bytes is exactly 32 chars. */
const CREATOR_API_KEY_PATTERN = /^cr_live_[A-Za-z0-9_-]{32}$/;

/** `cr_live_<32 base64url chars>` — 192 bits of entropy. Hashed with `hashApiKey` like seller keys. */
export function generateCreatorApiKey(): string {
  return `${CREATOR_API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export function isWellFormedCreatorApiKey(value: string): boolean {
  return CREATOR_API_KEY_PATTERN.test(value);
}

/**
 * Hex SHA-256 of the API key. A fast unsalted hash is appropriate here (unlike
 * passwords): keys are 256-bit random, so brute force is infeasible, and the
 * deterministic hash allows an indexed lookup.
 */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/** Constant-time string comparison (hashes both sides so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
