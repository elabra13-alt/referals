import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Passwordless creator access to one invitation, from the link in their
 * WhatsApp notice: /c/invitations/<id>?token=<magic token>.
 *
 * - The token is 32 random bytes (base64url, 43 chars); only its SHA-256 hex
 *   is stored (campaign_invitations.magic_token_hash), so a database leak
 *   doesn't yield working links.
 * - A valid token is exchanged once per visit for a short-lived, HttpOnly
 *   session cookie scoped to that invitation's path, and the browser is
 *   redirected to the token-less URL (token out of history and Referer).
 * - Sessions are stateless HMACs bound to the invitation, its creator and the
 *   current token hash: re-sending an invitation rotates the token and so
 *   invalidates every older link and session.
 */

export const MAGIC_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAGIC_SESSION_COOKIE = 'ref_inv';

const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const HASH_SHAPE = /^[0-9a-f]{64}$/;

export function hashMagicToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateMagicToken(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashMagicToken(token) };
}

/** Constant-time comparison of a presented token against the stored hash. */
export function magicTokenMatches(token: string, storedHash: string | null): boolean {
  if (!storedHash || !HASH_SHAPE.test(storedHash) || !TOKEN_SHAPE.test(token)) return false;
  return timingSafeEqual(Buffer.from(hashMagicToken(token), 'hex'), Buffer.from(storedHash, 'hex'));
}

export const PORTAL_SESSION_COOKIE = 'ref_creator';
const PORTAL_VALUE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

export interface PortalSessionSubject {
  id: string;
  apiKeyHash: string | null;
}

export interface MagicSessionSubject {
  invitationId: string;
  creatorId: string;
  magicTokenHash: string | null;
}

export class MagicSessions {
  private readonly key: Buffer;

  /** Derives a dedicated signing key from the server's master key (domain-separated, never the key itself). */
  constructor(masterKey: Buffer) {
    this.key = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'referals:creator-magic-session:v1', 32));
  }

  private mac(parts: string[]): string {
    return createHmac('sha256', this.key).update(parts.join('|')).digest('base64url');
  }

  private signature(subject: MagicSessionSubject, expiresAtMs: number): string {
    return this.mac(['session', subject.invitationId, subject.creatorId, subject.magicTokenHash ?? '', String(expiresAtMs)]);
  }

  /** Cookie value: `<expiry ms>.<signature>`. */
  issue(subject: MagicSessionSubject, now: Date): { value: string; maxAgeSeconds: number } {
    const expiresAtMs = now.getTime() + MAGIC_SESSION_TTL_MS;
    return { value: `${expiresAtMs}.${this.signature(subject, expiresAtMs)}`, maxAgeSeconds: MAGIC_SESSION_TTL_MS / 1000 };
  }

  verify(value: string | undefined, subject: MagicSessionSubject, now: Date): boolean {
    if (!value || !subject.magicTokenHash) return false;
    const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match) return false;
    const expiresAtMs = Number(match[1]);
    if (expiresAtMs <= now.getTime()) return false;
    const expected = Buffer.from(this.signature(subject, expiresAtMs));
    const presented = Buffer.from(match[2]!);
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }

  // ---------- Creator portal session (/c/wallet, /c/storefront, /c/invitations) ----------

  private portalSignature(subject: PortalSessionSubject, expiresAtMs: number): string {
    return this.mac(['portal', subject.id, subject.apiKeyHash ?? '', String(expiresAtMs)]);
  }

  /**
   * Creator-wide session opened alongside an invitation session by a valid magic link.
   * Cookie value: `<creator id>.<expiry ms>.<signature>`. Bound to the creator's API key
   * hash, so rotating the API key also signs every browser out.
   */
  issuePortal(subject: PortalSessionSubject, now: Date): { value: string; maxAgeSeconds: number } {
    const expiresAtMs = now.getTime() + MAGIC_SESSION_TTL_MS;
    return {
      value: `${subject.id}.${expiresAtMs}.${this.portalSignature(subject, expiresAtMs)}`,
      maxAgeSeconds: MAGIC_SESSION_TTL_MS / 1000,
    };
  }

  /** The creator id a portal cookie claims (unverified: look the creator up, then call verifyPortal). */
  portalCreatorId(value: string | undefined): string | null {
    return value ? (PORTAL_VALUE.exec(value)?.[1] ?? null) : null;
  }

  verifyPortal(value: string | undefined, subject: PortalSessionSubject, now: Date): boolean {
    const match = value ? PORTAL_VALUE.exec(value) : null;
    if (!match || match[1] !== subject.id) return false;
    const expiresAtMs = Number(match[2]);
    if (expiresAtMs <= now.getTime()) return false;
    const expected = Buffer.from(this.portalSignature(subject, expiresAtMs));
    const presented = Buffer.from(match[3]!);
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }

  /** Anti-CSRF token for the page's forms, derived from the session cookie (which other sites can't read). */
  csrfToken(sessionValue: string): string {
    return this.mac(['csrf', sessionValue]);
  }

  csrfMatches(sessionValue: string, presented: unknown): boolean {
    if (typeof presented !== 'string') return false;
    const expected = Buffer.from(this.csrfToken(sessionValue));
    const given = Buffer.from(presented);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

export function sessionCookiePath(invitationId: string): string {
  return `/c/invitations/${invitationId}`;
}

/** Reads one cookie from a Cookie header (no cookie plugin needed for a single value). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(invitationId: string, value: string, maxAgeSeconds: number): string {
  return `${MAGIC_SESSION_COOKIE}=${value}; Path=${sessionCookiePath(invitationId)}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/** Creator-wide portal session: every /c/ page (public storefront pages simply ignore it). */
export function portalCookie(value: string, maxAgeSeconds: number): string {
  return `${PORTAL_SESSION_COOKIE}=${value}; Path=/c; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}
