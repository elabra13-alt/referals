import { z } from 'zod';
import { AppError } from './errors.js';
import { numberToCents } from './money.js';

/** JSON number with at most 2 decimals -> integer cents (bigint). */
export const zMoneyCents = z
  .number()
  .nonnegative()
  .transform((v, ctx) => {
    const cents = numberToCents(v);
    if (cents === null) {
      ctx.addIssue({ code: 'custom', message: 'must be a non-negative amount with at most 2 decimals' });
      return z.NEVER;
    }
    return cents;
  });

/** Number with at most 4 decimals -> numeric(5,4) string, e.g. 0.15 -> "0.1500". */
const toScale4 = (v: number, ctx: z.RefinementCtx): string => {
  const scaled = Math.round(v * 10_000);
  if (Math.abs(v * 10_000 - scaled) > 1e-6) {
    ctx.addIssue({ code: 'custom', message: 'must have at most 4 decimal places' });
    return z.NEVER;
  }
  return `${Math.trunc(scaled / 10_000)}.${String(scaled % 10_000).padStart(4, '0')}`;
};

/** Rate in (0, 1] with at most 4 decimals, e.g. a commission. */
export const zRate = z.number().gt(0).lte(1).transform(toScale4);

/** Fraction in [0, 1] with at most 4 decimals, e.g. an engagement rate. */
export const zFraction = z.number().gte(0).lte(1).transform(toScale4);

/** Parses `data` or throws a 400 VALIDATION_ERROR listing every issue. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown, message = 'Invalid request.'): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', message, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
