import { describe, expect, it } from 'vitest';
import { centsToDecimal, commissionCents, decimalToScaled, numberToCents } from '../src/lib/money.js';
import { ATTRIBUTION_GRACE_MS, decideAttribution, type AttributableCode } from '../src/modules/webhooks/attribution.js';
import { computeEscrowUntil, escrowDaysForCategory } from '../src/modules/webhooks/escrow.js';
import { signPayload, verifySignature } from '../src/modules/webhooks/signature.js';

describe('escrowDaysForCategory', () => {
  it.each([
    ['beauty', 14],
    ['skincare', 14],
    ['consumables', 14],
    ['general', 21],
    ['home', 21],
    ['electronics', 25],
    ['audio', 25],
    ['fashion', 28],
    ['footwear', 28],
    ['apparel', 28],
    ['  Fashion ', 28],
    ['toys', 21],
    ['', 21],
  ])('%j -> %i days', (category, days) => {
    expect(escrowDaysForCategory(category)).toBe(days);
  });

  it('adds natural days to the sale timestamp', () => {
    expect(computeEscrowUntil(new Date('2026-10-13T16:00:00Z'), 14).toISOString()).toBe('2026-10-27T16:00:00.000Z');
  });
});

describe('decideAttribution', () => {
  const expiresAt = new Date('2026-10-01T00:00:00Z');
  const code: AttributableCode = {
    codeId: 'c1',
    code: 'REF-LEO-8K2M',
    status: 'issued',
    expiresAt,
    linkId: 'l1',
    sellerId: 's1',
  };
  const decide = (overrides: Partial<AttributableCode> = {}, orderedAt = new Date(expiresAt.getTime() - 1)) =>
    decideAttribution({ submittedCode: 'REF-LEO-8K2M', code: { ...code, ...overrides }, sellerId: 's1', orderedAt });

  it('attributes a live code', () => expect(decide()).toEqual({ attributed: true, reason: 'valid_code' }));

  it('attributes an expired code inside the 14-day grace window, inclusive', () => {
    expect(decide({}, new Date(expiresAt.getTime() + 1))).toEqual({ attributed: true, reason: 'grace_window' });
    expect(decide({}, new Date(expiresAt.getTime() + ATTRIBUTION_GRACE_MS))).toEqual({ attributed: true, reason: 'grace_window' });
  });

  it('rejects a code expired more than 14 days before the order', () => {
    expect(decide({}, new Date(expiresAt.getTime() + ATTRIBUTION_GRACE_MS + 1))).toEqual({ attributed: false, reason: 'code_expired' });
  });

  it.each([
    [{ sellerId: 'other' }, 'code_seller_mismatch'],
    [{ status: 'applied' as const }, 'code_already_used'],
    [{ status: 'revoked' as const }, 'code_revoked'],
  ])('rejects %j as %s', (overrides, reason) => {
    expect(decide(overrides)).toEqual({ attributed: false, reason });
  });

  it('rejects missing / unknown codes', () => {
    const orderedAt = new Date();
    expect(decideAttribution({ submittedCode: null, code: null, sellerId: 's1', orderedAt }).reason).toBe('no_code');
    expect(decideAttribution({ submittedCode: 'REF-X', code: null, sellerId: 's1', orderedAt }).reason).toBe('code_not_found');
  });
});

describe('money', () => {
  it('converts JSON numbers to cents exactly', () => {
    expect(numberToCents(1020)).toBe(102000n);
    expect(numberToCents(0.1 + 0.2)).toBe(30n);
    expect(numberToCents(19.99)).toBe(1999n);
    expect(numberToCents(1.005)).toBeNull();
  });

  it('computes commission with half-up rounding', () => {
    expect(commissionCents(102000n, '0.1500')).toBe(15300n); // 1020.00 × 15% = 153.00
    expect(commissionCents(333n, '0.1500')).toBe(50n); // 0.4995 -> 0.50
    expect(commissionCents(331n, '0.1500')).toBe(50n); // 0.4965 -> 0.50
    expect(commissionCents(329n, '0.1500')).toBe(49n); // 0.4935 -> 0.49
  });

  it('formats and parses decimals', () => {
    expect(centsToDecimal(15300n)).toBe('153.00');
    expect(centsToDecimal(5n)).toBe('0.05');
    expect(decimalToScaled('0.15', 4)).toBe(1500n);
    expect(() => decimalToScaled('0.12345', 4)).toThrow();
  });
});

describe('signature', () => {
  const body = Buffer.from('{"event":"order.paid"}');

  it('accepts a valid sha256= signature', () => {
    expect(verifySignature(body, signPayload(body, 'secret'), 'secret')).toBe(true);
  });

  it.each([
    ['wrong secret', signPayload(body, 'other')],
    ['missing prefix', signPayload(body, 'secret').slice('sha256='.length)],
    ['truncated', signPayload(body, 'secret').slice(0, -2)],
    ['garbage', 'sha256=zz'],
    ['undefined', undefined],
  ])('rejects %s', (_label, header) => {
    expect(verifySignature(body, header, 'secret')).toBe(false);
  });

  it('rejects a tampered body', () => {
    const sig = signPayload(body, 'secret');
    expect(verifySignature(Buffer.from('{"event":"order.paid" }'), sig, 'secret')).toBe(false);
  });
});
