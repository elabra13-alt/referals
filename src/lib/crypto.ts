import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for secrets at rest.
 * Stored format: `v1:<iv b64>:<auth tag b64>:<ciphertext b64>` (12-byte IV, 16-byte tag).
 * The version prefix leaves room for key rotation.
 */
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** AAD binding ciphertexts to their purpose, so one can't be replayed into another column. */
export const WEBHOOK_SECRET_AAD = 'sellers.webhook_secret';

/**
 * Accepts a 64-char hex string (raw 32-byte key) or a passphrase of at least
 * 32 chars, which is stretched to 32 bytes with SHA-256.
 */
export function parseEncryptionKey(value: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (value.length < KEY_BYTES) throw new Error('Encryption key must be 64 hex chars or a passphrase of at least 32 chars');
  return createHash('sha256').update(value, 'utf8').digest();
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new Error(`Encryption key must be ${KEY_BYTES} bytes`);
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(`${VERSION}:`) && value.split(':').length === 4;
}

export function encryptSecret(plaintext: string, key: Buffer, aad = WEBHOOK_SECRET_AAD): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

/** Throws if the value was tampered with, or was encrypted under a different key or AAD. */
export function decryptSecret(stored: string, key: Buffer, aad = WEBHOOK_SECRET_AAD): string {
  assertKey(key);
  const [version, ivB64, tagB64, ctB64] = stored.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error('Unsupported secret format');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
