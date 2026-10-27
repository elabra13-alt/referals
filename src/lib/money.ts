/**
 * Money is handled as integer minor units (cents) in BigInt to avoid float
 * drift, and as fixed-scale decimal strings at the DB / JSON boundary.
 */

/** Converts a JSON number with at most 2 decimals to cents; null if it has more precision. */
export function numberToCents(value: number): bigint | null {
  if (!Number.isFinite(value)) return null;
  const scaled = value * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6 || !Number.isSafeInteger(rounded)) return null;
  return BigInt(rounded);
}

/** Parses a non-negative decimal string (e.g. "0.1500") into an integer at the given scale. */
export function decimalToScaled(value: string, scale: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal: ${value}`);
  const [, whole, frac = ''] = match;
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) {
    throw new Error(`Decimal ${value} exceeds scale ${scale}`);
  }
  return BigInt(whole! + frac.slice(0, scale).padEnd(scale, '0'));
}

export function centsToDecimal(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const str = `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  return negative ? `-${str}` : str;
}

/** Parses a signed numeric(…,2) string (e.g. "-153.00") into cents. */
export function decimalToCents(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const cents = decimalToScaled(negative ? trimmed.slice(1) : trimmed, 2);
  return negative ? -cents : cents;
}

const RATE_SCALE = 4;
const RATE_DENOMINATOR = 10n ** BigInt(RATE_SCALE);

/** amount × rate, rounded half-up to the cent. `rate` is a non-negative numeric(5,4) string. */
export function applyRate(amountCents: bigint, rate: string): bigint {
  const rateScaled = decimalToScaled(rate, RATE_SCALE);
  return (amountCents * rateScaled * 2n + RATE_DENOMINATOR) / (2n * RATE_DENOMINATOR);
}

/** Creator commission on net_total. */
export function commissionCents(netCents: bigint, commissionRate: string): bigint {
  return applyRate(netCents, commissionRate);
}

/** Referals take rate on net_total, owed by the seller on top of the creator commission. */
export function platformFeeCents(netCents: bigint, platformFeeRate: string): bigint {
  return applyRate(netCents, platformFeeRate);
}
