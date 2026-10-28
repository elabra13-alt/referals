import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client.js';
import { creatorLoginTokens, creators, type Creator } from '../../db/schema.js';
import { isE164, maskPhone, stripPhoneSeparators } from '../../lib/phone.js';
import type { RedisClient } from '../../lib/redis.js';
import { SLIDING_WINDOW_LUA } from '../codes/anti-fraud-shield.js';
import type { WhatsAppNotificationService } from '../notifications/whatsapp.service.js';

/**
 * Passwordless portal re-entry (/c/login): a creator types their WhatsApp number
 * and receives a single-use, 15-minute login link there.
 *
 * - The answer never depends on whether the number belongs to a creator: the
 *   lookup, token minting and WhatsApp send all run after the response is sent.
 * - Tokens are 32 random bytes (hex); only their SHA-256 is stored, and they are
 *   consumed with one conditional UPDATE, so two clicks can't both log in.
 */

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const LOGIN_RATE_LIMIT = { MAX_REQUESTS: 3, WINDOW_MS: 15 * 60 * 1000 } as const;
/** One phone can belong to several creator accounts; each gets its own link (bounded). */
const MAX_ACCOUNTS_PER_PHONE = 3;
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Normalizes what a Mexican creator types into E.164: "55 1234 5678" → "+525512345678".
 * Accepts 10 national digits, 52 + 10 digits, legacy mobile "+521…", or any valid E.164.
 */
export function normalizeLoginPhone(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 40) return null;
  const value = stripPhoneSeparators(input);
  if (/^\d{10}$/.test(value)) return `+52${value}`;
  if (/^52\d{10}$/.test(value)) return `+${value}`;
  if (/^\+521\d{10}$/.test(value)) return `+52${value.slice(4)}`;
  return isE164(value) ? value : null;
}

export const hashLoginToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export type LoginRequestResult = { status: 'accepted' } | { status: 'rate_limited'; retryAfterSeconds: number };

export type LoginConsumeResult = { status: 'ok'; creator: Creator } | { status: 'invalid' } | { status: 'expired' };

export class PortalAuthService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      db: Database;
      redis: RedisClient;
      whatsapp: WhatsAppNotificationService;
      /** Absolute URL of GET /c/login/verify; `?token=` is appended. */
      loginVerifyUrl: string;
      log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Sliding window shared by the IP and phone limits (3 per 15 minutes each). */
  private async hit(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const nowMs = this.now().getTime();
    const raw = (await this.deps.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      nowMs,
      LOGIN_RATE_LIMIT.WINDOW_MS,
      LOGIN_RATE_LIMIT.MAX_REQUESTS,
      `${nowMs}:${randomUUID()}`,
    )) as [number, number, number];
    const [allowed, , retryAfterMs] = raw.map(Number) as [number, number, number];
    return { allowed: allowed === 1, retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }

  /**
   * Rate-limits by IP, then by phone, and (when allowed) queues the link in the
   * background. Registered or not, every allowed request gets the same answer.
   */
  async requestLogin(phone: string, ip: string): Promise<LoginRequestResult> {
    const byIp = await this.hit(`rl:login:ip:${ip}`);
    if (!byIp.allowed) return { status: 'rate_limited', retryAfterSeconds: byIp.retryAfterSeconds };
    // Keyed by a hash: no phone numbers in Redis.
    const byPhone = await this.hit(`rl:login:phone:${hashLoginToken(phone)}`);
    if (!byPhone.allowed) return { status: 'rate_limited', retryAfterSeconds: byPhone.retryAfterSeconds };

    setImmediate(() => {
      this.sendLoginLinks(phone).catch((err: unknown) =>
        this.deps.log.error({ to: maskPhone(phone), error: (err as Error).message }, 'portal login dispatch failed'),
      );
    });
    return { status: 'accepted' };
  }

  /** Mints a token and sends a link to every active, opted-in creator on this number. Returns how many were sent. */
  async sendLoginLinks(phone: string): Promise<number> {
    const accounts = await this.deps.db
      .select()
      .from(creators)
      .where(and(eq(creators.phone, phone), eq(creators.status, 'active'), isNotNull(creators.whatsappOptInAt)))
      .limit(MAX_ACCOUNTS_PER_PHONE);

    let sent = 0;
    for (const creator of accounts) {
      const token = randomBytes(32).toString('hex');
      await this.deps.db.insert(creatorLoginTokens).values({
        creatorId: creator.id,
        tokenHash: hashLoginToken(token),
        expiresAt: new Date(this.now().getTime() + LOGIN_TOKEN_TTL_MS),
      });
      const url = `${this.deps.loginVerifyUrl}?token=${token}`;
      const result = await this.deps.whatsapp.sendLoginNotification(creator, url);
      if (result.status === 'sent') sent++;
    }
    return sent;
  }

  /** Validates and burns a login token in one statement (strictly single-use). */
  async consume(token: unknown): Promise<LoginConsumeResult> {
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return { status: 'invalid' };
    const tokenHash = hashLoginToken(token);
    const now = this.now();

    const [used] = await this.deps.db
      .update(creatorLoginTokens)
      .set({ usedAt: now })
      .where(and(eq(creatorLoginTokens.tokenHash, tokenHash), isNull(creatorLoginTokens.usedAt), gte(creatorLoginTokens.expiresAt, now)))
      .returning({ creatorId: creatorLoginTokens.creatorId });

    if (!used) {
      const [known] = await this.deps.db
        .select({ id: creatorLoginTokens.id })
        .from(creatorLoginTokens)
        .where(eq(creatorLoginTokens.tokenHash, tokenHash))
        .limit(1);
      // Already used or past its 15 minutes: the creator just needs a new link.
      return known ? { status: 'expired' } : { status: 'invalid' };
    }

    const [creator] = await this.deps.db.select().from(creators).where(eq(creators.id, used.creatorId));
    if (!creator || creator.status !== 'active') return { status: 'invalid' };
    return { status: 'ok', creator };
  }
}
