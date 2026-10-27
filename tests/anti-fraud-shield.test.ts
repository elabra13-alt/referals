import { beforeEach, describe, expect, it } from 'vitest';
import type { RedisClient } from '../src/lib/redis.js';
import { AntiFraudShield, IP_RATE_LIMIT_WINDOW_MS } from '../src/modules/codes/anti-fraud-shield.js';
import { TestClock, createTestRedis } from './helpers.js';

describe('AntiFraudShield', () => {
  let redis: RedisClient;
  let clock: TestClock;
  let shield: AntiFraudShield;

  beforeEach(async () => {
    redis = await createTestRedis();
    clock = new TestClock();
    shield = new AntiFraudShield(redis, { now: clock.nowMs });
  });

  describe('IP sliding window', () => {
    it('allows 5 requests per 60 minutes, then rejects with Retry-After', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await shield.checkIpRateLimit('189.200.45.12')).allowed).toBe(true);
        clock.advance(60_000);
      }
      const denied = await shield.checkIpRateLimit('189.200.45.12');
      expect(denied.allowed).toBe(false);
      // Oldest hit was 5 min ago, so it slides out of the window in 55 min.
      expect(denied.retryAfterSeconds).toBe(55 * 60);

      await expect(shield.enforceIpRateLimit('189.200.45.12')).rejects.toMatchObject({
        statusCode: 429,
        headers: { 'Retry-After': String(55 * 60) },
      });
    });

    it('frees a slot once the oldest request leaves the window', async () => {
      for (let i = 0; i < 5; i++) await shield.checkIpRateLimit('1.1.1.1');
      expect((await shield.checkIpRateLimit('1.1.1.1')).allowed).toBe(false);
      clock.advance(IP_RATE_LIMIT_WINDOW_MS + 1);
      expect((await shield.checkIpRateLimit('1.1.1.1')).allowed).toBe(true);
    });

    it('isolates IPs', async () => {
      for (let i = 0; i < 5; i++) await shield.checkIpRateLimit('1.1.1.1');
      expect((await shield.checkIpRateLimit('2.2.2.2')).allowed).toBe(true);
    });
  });

  describe('disposable emails', () => {
    it.each(['a@mailinator.com', 'a@TempMail.com', 'a@10minutemail.com', 'a@guerrillamail.com', 'a@eu.mailinator.com'])(
      'flags %s',
      (email) => expect(shield.isDisposableEmail(email)).toBe(true),
    );

    it.each(['valeria@gmail.com', 'x@notmailinator.com', 'x@mailinator.com.mx'])('allows %s', (email) =>
      expect(shield.isDisposableEmail(email)).toBe(false),
    );

    it('assertEmailAllowed throws 422', () => {
      expect(() => shield.assertEmailAllowed('a@mailinator.com')).toThrow(
        expect.objectContaining({ statusCode: 422, code: 'DISPOSABLE_EMAIL' }),
      );
      expect(() => shield.assertEmailAllowed(null)).not.toThrow();
    });
  });

  describe('issuance lock', () => {
    it('serializes concurrent issuance for the same buyer identity', async () => {
      const order: string[] = [];
      const buyer = { email: 'v@gmail.com', phone: null };
      const task = (name: string) =>
        shield.withIssuanceLock('link-1', buyer, async () => {
          order.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, 50));
          order.push(`${name}:end`);
        });
      await Promise.all([task('a'), task('b')]);
      expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    it('releases the lock when the critical section throws', async () => {
      const buyer = { email: null, phone: '+5215512345678' };
      await expect(shield.withIssuanceLock('l', buyer, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      await expect(shield.withIssuanceLock('l', buyer, async () => 'ok')).resolves.toBe('ok');
    });
  });
});
