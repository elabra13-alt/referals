import { describe, expect, it, vi } from 'vitest';
import {
  CODE_PATTERN,
  CODE_TTL_MS,
  CodeGenerator,
  ENTROPY_ALPHABET,
  ENTROPY_LENGTH,
  deriveCreatorSlug,
  generateEntropy,
} from '../../src/modules/codes/code-generator.js';

/**
 * Storefront coupons are issued by the same engine as link-page coupons, so
 * these tests pin the AGENTS.md §5 contract for every coupon in the system:
 * REF-[CREATOR_SLUG]-[ENTROPY], 3–5 char slug, 4 chars of Modified Crockford
 * Base32, 48h expiry.
 */

const AGENTS_FORMAT = /^REF-[A-Z0-9]{3,5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
const NOW = new Date('2026-10-26T18:00:00.000Z');

describe('coupon format', () => {
  it('produces REF-[CREATOR_SLUG]-[ENTROPY] codes that fit codes.code varchar(16)', () => {
    const gen = new CodeGenerator({ now: () => NOW });
    for (const handle of ['leo', '@Valeria.Glow', 'Ñoño_mx', 'jo', 'SOFIA2026']) {
      const { code } = gen.generate(handle, 'https://shop.example.mx/checkout');
      expect(code).toMatch(AGENTS_FORMAT);
      expect(code).toMatch(CODE_PATTERN);
      expect(code.length).toBeLessThanOrEqual(16);
    }
  });

  it('derives a stable 3–5 char uppercase alphanumeric creator slug', () => {
    expect(deriveCreatorSlug('VALERIA')).toBe('VALER');
    expect(deriveCreatorSlug('leo')).toBe('LEO');
    expect(deriveCreatorSlug('jo')).toMatch(/^JO[A-Z0-9]$/);
    expect(deriveCreatorSlug('jo')).toBe(deriveCreatorSlug('jo'));
  });
});

describe('entropy (Modified Crockford Base32)', () => {
  it('uses exactly the AGENTS.md alphabet and never the ambiguous 0, O, 1, I, L', () => {
    expect(ENTROPY_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(ENTROPY_ALPHABET).toHaveLength(30);
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) expect(ENTROPY_ALPHABET).not.toContain(ambiguous);
    expect(ENTROPY_LENGTH).toBe(4);
  });

  it('is uniformly distributed (chi-square, 30k samples)', () => {
    const counts = new Map<string, number>([...ENTROPY_ALPHABET].map((c) => [c, 0]));
    const samples = 7_500; // x4 chars = 30,000 symbols
    for (let i = 0; i < samples; i++) {
      for (const c of generateEntropy()) counts.set(c, counts.get(c)! + 1);
    }
    const expected = (samples * ENTROPY_LENGTH) / ENTROPY_ALPHABET.length;
    const chi2 = [...counts.values()].reduce((sum, n) => sum + (n - expected) ** 2 / expected, 0);
    // df = 29; the p = 1e-6 critical value is ~79, so a fair generator fails this ~never.
    expect(chi2).toBeLessThan(79);
    expect([...counts.keys()].every((c) => ENTROPY_ALPHABET.includes(c))).toBe(true);
  });

  it('draws every symbol through the injected RNG (deterministic when seeded)', () => {
    const rng = vi.fn((max: number) => max - 1);
    expect(generateEntropy(rng)).toBe('ZZZZ');
    expect(rng).toHaveBeenCalledTimes(4);
    expect(rng).toHaveBeenCalledWith(30);
  });

  it('has 30^4 = 810,000 codes per creator slug, so collisions are expected and retried', async () => {
    expect(ENTROPY_ALPHABET.length ** ENTROPY_LENGTH).toBe(810_000);
    const taken = Object.assign(new Error('duplicate key value violates unique constraint "codes_code_unique"'), {
      code: '23505',
      constraint: 'codes_code_unique',
    });
    const persist = vi.fn().mockRejectedValueOnce(taken).mockImplementation(async (c: { code: string }) => c.code);
    await expect(new CodeGenerator().generateUnique('leo', 'https://shop.example.mx', persist)).resolves.toMatch(AGENTS_FORMAT);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

describe('expiration', () => {
  it('expires exactly 48 hours after issuance', () => {
    const c = new CodeGenerator({ now: () => NOW }).generate('leo', 'https://shop.example.mx/checkout');
    expect(c.issuedAt).toEqual(NOW);
    expect(c.expiresAt.toISOString()).toBe('2026-10-28T18:00:00.000Z');
    expect(c.expiresAt.getTime() - c.issuedAt.getTime()).toBe(CODE_TTL_MS);
    expect(CODE_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });

  it('builds the auto-apply URL with the code and UTM attribution', () => {
    const c = new CodeGenerator({ now: () => NOW }).generate('leo', 'https://shop.example.mx/checkout?ref=ig');
    const url = new URL(c.autoApplyUrl);
    expect(url.searchParams.get('discount')).toBe(c.code);
    expect(url.searchParams.get('ref')).toBe('ig');
    expect(url.searchParams.get('utm_campaign')).toBe('LEO');
  });
});

describe('generation cost', () => {
  it('generates 10,000 coupons in well under the 400ms on-screen budget', () => {
    const gen = new CodeGenerator({ now: () => NOW });
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) gen.generate('valeria', 'https://shop.example.mx/checkout');
    // One coupon needs one generation (plus a DB insert); 10k here bounds the CPU share far below budget.
    expect(performance.now() - start).toBeLessThan(400);
  });
});
