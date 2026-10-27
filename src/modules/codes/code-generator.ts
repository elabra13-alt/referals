import { createHash, randomInt } from 'node:crypto';
import { isUniqueViolation } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';

/** Modified Crockford Base32 (AGENTS.md §5): no 0, O, 1, I, L (nor U). */
export const ENTROPY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ENTROPY_LENGTH = 4;
export const CODE_PREFIX = 'REF';
export const CREATOR_SLUG_MIN = 3;
export const CREATOR_SLUG_MAX = 5;
export const CODE_TTL_MS = 48 * 60 * 60 * 1000;
export const MAX_COLLISION_RETRIES = 3;

export const CODE_PATTERN = /^REF-[A-Z0-9]{3,5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;

const CODE_UNIQUE_CONSTRAINT = 'codes_code_unique';

/** Returns a uniformly distributed integer in [0, max). */
export type RandomInt = (max: number) => number;

/**
 * Derives the 3–5 char CREATOR_SLUG from a creator handle.
 * Accents are folded ("Ñañita" -> "NANIT"); non-alphanumerics are dropped.
 * Handles shorter than 3 usable chars are padded deterministically from a hash
 * of the handle, so the same creator always gets the same slug.
 */
export function deriveCreatorSlug(handle: string): string {
  const cleaned = handle
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CREATOR_SLUG_MAX);

  if (cleaned.length >= CREATOR_SLUG_MIN) return cleaned;

  const digest = createHash('sha256').update(handle).digest();
  let slug = cleaned;
  for (let i = 0; slug.length < CREATOR_SLUG_MIN; i++) {
    slug += ENTROPY_ALPHABET[digest[i]! % ENTROPY_ALPHABET.length];
  }
  return slug;
}

export function generateEntropy(rng: RandomInt = randomInt, length = ENTROPY_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ENTROPY_ALPHABET[rng(ENTROPY_ALPHABET.length)];
  return out;
}

export function buildAutoApplyUrl(checkoutBaseUrl: string, code: string, creatorSlug: string): string {
  const url = new URL(checkoutBaseUrl);
  url.searchParams.set('discount', code);
  url.searchParams.set('utm_source', 'referals');
  url.searchParams.set('utm_campaign', creatorSlug);
  return url.toString();
}

export interface CodeCandidate {
  code: string;
  creatorSlug: string;
  issuedAt: Date;
  expiresAt: Date;
  autoApplyUrl: string;
}

export interface CodeGeneratorOptions {
  rng?: RandomInt;
  now?: () => Date;
  ttlMs?: number;
  maxRetries?: number;
}

export class CodeGenerator {
  private readonly rng: RandomInt;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxRetries: number;

  constructor(opts: CodeGeneratorOptions = {}) {
    this.rng = opts.rng ?? randomInt;
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? CODE_TTL_MS;
    this.maxRetries = opts.maxRetries ?? MAX_COLLISION_RETRIES;
  }

  generate(creatorHandle: string, checkoutBaseUrl: string): CodeCandidate {
    const creatorSlug = deriveCreatorSlug(creatorHandle);
    const code = `${CODE_PREFIX}-${creatorSlug}-${generateEntropy(this.rng)}`;
    const issuedAt = this.now();
    return {
      code,
      creatorSlug,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + this.ttlMs),
      autoApplyUrl: buildAutoApplyUrl(checkoutBaseUrl, code, creatorSlug),
    };
  }

  /**
   * Generates a candidate and hands it to `persist`. If persisting hits the
   * `codes.code` UNIQUE constraint, a fresh candidate is generated — up to
   * `maxRetries` retries (i.e. maxRetries + 1 attempts in total).
   */
  async generateUnique<T>(
    creatorHandle: string,
    checkoutBaseUrl: string,
    persist: (candidate: CodeCandidate) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const candidate = this.generate(creatorHandle, checkoutBaseUrl);
      try {
        return await persist(candidate);
      } catch (err) {
        if (!isUniqueViolation(err, CODE_UNIQUE_CONSTRAINT)) throw err;
        if (attempt >= this.maxRetries) {
          throw new AppError(
            503,
            'CODE_GENERATION_EXHAUSTED',
            'Could not allocate a unique discount code. Please retry.',
            undefined,
            { 'Retry-After': '1' },
          );
        }
      }
    }
  }
}
