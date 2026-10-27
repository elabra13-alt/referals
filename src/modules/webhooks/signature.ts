import { createHmac, timingSafeEqual } from 'node:crypto';
import { decryptSecret, isEncryptedSecret } from '../../lib/crypto.js';

export const SIGNATURE_HEADER = 'x-referals-signature';
export const SELLER_ID_HEADER = 'x-referals-seller-id';

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

export function signPayload(rawBody: Buffer | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export type StoredSecretResolution =
  | { ok: true; secret: string; legacyPlaintext: boolean }
  | { ok: false; error: Error };

/**
 * Turns a stored `sellers.webhook_secret` into the HMAC key. Encrypted values
 * (AES-256-GCM) are decrypted; legacy plaintext rows are passed through and
 * flagged so callers can warn until `db:encrypt-secrets` has been run.
 */
export function resolveStoredSecret(stored: string, encryptionKey: Buffer): StoredSecretResolution {
  if (!isEncryptedSecret(stored)) return { ok: true, secret: stored, legacyPlaintext: true };
  try {
    return { ok: true, secret: decryptSecret(stored, encryptionKey), legacyPlaintext: false };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}

/** Constant-time check of `sha256=<hex>` against HMAC-SHA256(secret, rawBody). */
export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  const match = header ? SIGNATURE_PATTERN.exec(header.trim()) : null;
  if (!match) return false;
  const provided = Buffer.from(match[1]!.toLowerCase(), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
