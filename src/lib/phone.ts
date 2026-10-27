/** E.164: "+", country code (no leading 0), up to 15 digits total. e.g. "+525512345678". */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** Strips the separators people type ("+52 55-1234 5678", "(55) 1234…"); does not guess a country code. */
export function stripPhoneSeparators(value: string): string {
  return value.trim().replace(/[\s\-().]/g, '');
}

export function isE164(value: string): boolean {
  return E164_PATTERN.test(value);
}

/** For logs: "+52•••••••5678". Phone numbers are personal data. */
export function maskPhone(e164: string): string {
  return e164.length <= 7 ? '•••' : `${e164.slice(0, 3)}${'•'.repeat(e164.length - 7)}${e164.slice(-4)}`;
}
