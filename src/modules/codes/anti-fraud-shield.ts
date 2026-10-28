import { randomUUID } from 'node:crypto';
import type { RedisClient } from '../../lib/redis.js';
import { AppError } from '../../lib/errors.js';
import { LockNotAcquiredError, withRedisLock } from '../../lib/redis-lock.js';

export const IP_RATE_LIMIT_MAX = 5;
export const IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

const ISSUANCE_LOCK_TTL_MS = 5_000;
const ISSUANCE_LOCK_MAX_WAIT_MS = 400;

export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com',
  'tempmail.com',
  'temp-mail.org',
  '10minutemail.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamailblock.com',
  'sharklasers.com',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'dispostable.com',
  'throwawaymail.com',
  'maildrop.cc',
  'fakeinbox.com',
]);

/**
 * Sliding-window log: one ZSET member per accepted request, scored by epoch ms.
 * Atomic so concurrent requests from one IP can't overshoot the limit.
 * Returns {allowed, remaining, retryAfterMs}.
 */
export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, ARGV[4])
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, 0, window - (now - tonumber(oldest[2]))}
`;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface BuyerIdentity {
  email: string | null;
  phone: string | null;
}

export interface AntiFraudShieldOptions {
  now?: () => number;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

export class AntiFraudShield {
  private readonly now: () => number;
  private readonly rateLimitMax: number;
  private readonly rateLimitWindowMs: number;

  constructor(
    private readonly redis: RedisClient,
    opts: AntiFraudShieldOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.rateLimitMax = opts.rateLimitMax ?? IP_RATE_LIMIT_MAX;
    this.rateLimitWindowMs = opts.rateLimitWindowMs ?? IP_RATE_LIMIT_WINDOW_MS;
  }

  async checkIpRateLimit(ip: string): Promise<RateLimitResult> {
    const raw = (await this.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      `rl:codes:request:ip:${ip}`,
      this.now(),
      this.rateLimitWindowMs,
      this.rateLimitMax,
      `${this.now()}:${randomUUID()}`,
    )) as [number, number, number];
    const [allowed, remaining, retryAfterMs] = raw.map(Number) as [number, number, number];
    return {
      allowed: allowed === 1,
      remaining,
      retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  /** Throws HTTP 429 (with Retry-After) when the IP exceeded its window. */
  async enforceIpRateLimit(ip: string): Promise<void> {
    const result = await this.checkIpRateLimit(ip);
    if (!result.allowed) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Too many code requests from this network. Please try again later.',
        { retry_after_seconds: result.retryAfterSeconds },
        { 'Retry-After': String(result.retryAfterSeconds) },
      );
    }
  }

  isDisposableEmail(email: string): boolean {
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    if (!domain) return false;
    // Match the domain itself and any parent domain (e.g. "eu.mailinator.com").
    const labels = domain.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      if (DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(i).join('.'))) return true;
    }
    return false;
  }

  /** Throws HTTP 422 for throwaway inboxes. */
  assertEmailAllowed(email: string | null): void {
    if (email && this.isDisposableEmail(email)) {
      throw new AppError(422, 'DISPOSABLE_EMAIL', 'Please use a permanent email address to receive your code.');
    }
  }

  /**
   * Serializes issuance per (link, buyer identity) so two concurrent requests
   * can't both pass the 24h duplicate guard. Waits briefly for an in-flight
   * request (e.g. a double click) so the loser can return its result as a 409.
   */
  async withIssuanceLock<T>(linkId: string, buyer: BuyerIdentity, fn: () => Promise<T>): Promise<T> {
    // Hash-tag on link id keeps all keys in one cluster slot for the multi-key Lua scripts.
    const keys = [
      buyer.email ? `lock:codes:{${linkId}}:email:${buyer.email}` : null,
      buyer.phone ? `lock:codes:{${linkId}}:phone:${buyer.phone}` : null,
    ].filter((k): k is string => k !== null);
    try {
      return await withRedisLock(this.redis, keys, { ttlMs: ISSUANCE_LOCK_TTL_MS, maxWaitMs: ISSUANCE_LOCK_MAX_WAIT_MS }, fn);
    } catch (err) {
      if (err instanceof LockNotAcquiredError) {
        throw new AppError(409, 'REQUEST_IN_FLIGHT', 'A code for this buyer is already being issued. Please retry.', undefined, {
          'Retry-After': '1',
        });
      }
      throw err;
    }
  }
}
