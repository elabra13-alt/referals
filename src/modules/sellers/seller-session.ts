import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Browser session for the seller dashboard (/seller/*), opened by signing in
 * with the seller's API key (or the platform admin token + seller id).
 *
 * Cookie `ref_seller` = `<seller id>.<expiry ms>.<HMAC>`: stateless, HttpOnly,
 * scoped to /seller. The HMAC covers the seller's current API key hash, so
 * rotating the key signs every browser out.
 */

export const SELLER_SESSION_COOKIE = 'ref_seller';
export const SELLER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const SESSION_VALUE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

export interface SellerSessionSubject {
  id: string;
  apiKeyHash: string | null;
}

export class SellerSessions {
  private readonly key: Buffer;

  /** Own HKDF-derived key: a creator session can never verify as a seller one. */
  constructor(masterKey: Buffer) {
    this.key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'referals:seller-dashboard-session:v1', 32));
  }

  private mac(parts: string[]): string {
    return createHmac('sha256', this.key).update(parts.join('|')).digest('base64url');
  }

  private signature(subject: SellerSessionSubject, expiresAtMs: number): string {
    return this.mac(['seller', subject.id, subject.apiKeyHash ?? '', String(expiresAtMs)]);
  }

  issue(subject: SellerSessionSubject, now: Date): { value: string; maxAgeSeconds: number } {
    const expiresAtMs = now.getTime() + SELLER_SESSION_TTL_MS;
    return { value: `${subject.id}.${expiresAtMs}.${this.signature(subject, expiresAtMs)}`, maxAgeSeconds: SELLER_SESSION_TTL_MS / 1000 };
  }

  /** The seller id a cookie claims (unverified: look the seller up, then call verify). */
  sellerId(value: string | undefined): string | null {
    return value ? (SESSION_VALUE.exec(value)?.[1] ?? null) : null;
  }

  verify(value: string | undefined, subject: SellerSessionSubject, now: Date): boolean {
    const match = value ? SESSION_VALUE.exec(value) : null;
    if (!match || match[1] !== subject.id) return false;
    const expiresAtMs = Number(match[2]);
    if (expiresAtMs <= now.getTime()) return false;
    const expected = Buffer.from(this.signature(subject, expiresAtMs));
    const presented = Buffer.from(match[3]!);
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }

  /** Anti-CSRF token for dashboard forms (also used before sign-in, keyed by the login form cookie). */
  csrfToken(scope: string): string {
    return this.mac(['csrf', scope]);
  }

  csrfMatches(scope: string, presented: unknown): boolean {
    if (typeof presented !== 'string') return false;
    const expected = Buffer.from(this.csrfToken(scope));
    const given = Buffer.from(presented);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

export function sellerSessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SELLER_SESSION_COOKIE}=${value}; Path=/seller; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}
