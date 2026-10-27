import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import {
  CODE_PATTERN,
  CODE_TTL_MS,
  CodeGenerator,
  ENTROPY_ALPHABET,
  buildAutoApplyUrl,
  deriveCreatorSlug,
  generateEntropy,
} from '../src/modules/codes/code-generator.js';

const uniqueViolation = () =>
  Object.assign(new Error('duplicate key value violates unique constraint "codes_code_unique"'), {
    code: '23505',
    constraint: 'codes_code_unique',
  });

describe('deriveCreatorSlug', () => {
  it.each([
    ['leo', 'LEO'],
    ['@Valeria.Glow', 'VALER'],
    ['Ñoño_mx', 'NONOM'],
    ['ana-23', 'ANA23'],
  ])('%s -> %s', (handle, slug) => {
    expect(deriveCreatorSlug(handle)).toBe(slug);
  });

  it('pads short handles deterministically to 3 chars', () => {
    const slug = deriveCreatorSlug('jo');
    expect(slug).toMatch(/^JO[A-Z0-9]$/);
    expect(deriveCreatorSlug('jo')).toBe(slug);
    expect(deriveCreatorSlug('__')).toMatch(/^[A-Z0-9]{3}$/);
  });
});

describe('generateEntropy', () => {
  it('only uses the Modified Crockford Base32 alphabet', () => {
    expect(ENTROPY_ALPHABET).not.toMatch(/[01OIL]/);
    for (let i = 0; i < 5_000; i++) {
      expect(generateEntropy()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/);
    }
  });
});

describe('buildAutoApplyUrl', () => {
  it('injects discount + UTM params and preserves the existing query', () => {
    const url = new URL(buildAutoApplyUrl('https://shop.mx/checkout?cart=9', 'REF-LEO-7KQ9', 'LEO'));
    expect(url.searchParams.get('cart')).toBe('9');
    expect(url.searchParams.get('discount')).toBe('REF-LEO-7KQ9');
    expect(url.searchParams.get('utm_source')).toBe('referals');
    expect(url.searchParams.get('utm_campaign')).toBe('LEO');
  });
});

describe('CodeGenerator', () => {
  const now = new Date('2026-10-13T15:00:00.000Z');

  it('generates REF-[SLUG]-[ENTROPY] expiring in 48h', () => {
    const c = new CodeGenerator({ now: () => now }).generate('leo', 'https://shop.mx/checkout');
    expect(c.code).toMatch(CODE_PATTERN);
    expect(c.code.startsWith('REF-LEO-')).toBe(true);
    expect(c.code.length).toBeLessThanOrEqual(16);
    expect(c.expiresAt.getTime() - c.issuedAt.getTime()).toBe(CODE_TTL_MS);
    expect(c.autoApplyUrl).toBe(`https://shop.mx/checkout?discount=${c.code}&utm_source=referals&utm_campaign=LEO`);
  });

  it('retries on code collisions and returns the first persisted code', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockRejectedValueOnce({ cause: uniqueViolation() }) // drizzle-wrapped driver error
      .mockImplementation(async (c: { code: string }) => c.code);
    const code = await new CodeGenerator().generateUnique('leo', 'https://shop.mx', persist);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(code).toMatch(CODE_PATTERN);
  });

  it('gives up after 3 retries (4 attempts) with 503', async () => {
    const persist = vi.fn().mockRejectedValue(uniqueViolation());
    const err = await new CodeGenerator().generateUnique('leo', 'https://shop.mx', persist).catch((e: unknown) => e);
    expect(persist).toHaveBeenCalledTimes(4);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 503, code: 'CODE_GENERATION_EXHAUSTED' });
  });

  it('does not retry unrelated errors', async () => {
    const persist = vi.fn().mockRejectedValue(new Error('connection reset'));
    await expect(new CodeGenerator().generateUnique('leo', 'https://shop.mx', persist)).rejects.toThrow('connection reset');
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
