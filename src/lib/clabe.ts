/**
 * CLABE (Clave Bancaria Estandarizada), Mexico's 18-digit interbank account number:
 *   digits 1–3   bank code (Banxico participant)
 *   digits 4–6   plaza (city/region)
 *   digits 7–17  account number
 *   digit  18    control digit
 * Control digit (Banxico Modulo-10): weights 3,7,1 repeating over the first 17
 * digits; sum (digit × weight) mod 10; control = (10 − sum mod 10) mod 10.
 */
const WEIGHTS = [3, 7, 1] as const;

export function clabeCheckDigit(first17: string): number {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (Number(first17[i]) * WEIGHTS[i % 3]!) % 10;
  return (10 - (sum % 10)) % 10;
}

export function isValidClabe(value: string): boolean {
  if (!/^\d{18}$/.test(value)) return false;
  return clabeCheckDigit(value.slice(0, 17)) === Number(value[17]);
}

/** Only the last 4 digits ever leave the API: "**************9719". */
export function maskClabe(value: string): string {
  return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * Banxico SPEI participant codes (first 3 CLABE digits) → display name.
 * Partial: the institutions creators most commonly bank with. A code missing
 * here is NOT invalid — it just resolves to no name. Keep in sync with
 * Banxico's participant catalog.
 */
export const MX_BANKS: Readonly<Record<string, string>> = {
  '002': 'Banamex',
  '006': 'Bancomext',
  '009': 'Banobras',
  '012': 'BBVA México',
  '014': 'Santander',
  '019': 'Banjército',
  '021': 'HSBC',
  '030': 'BanBajío',
  '036': 'Inbursa',
  '042': 'Mifel',
  '044': 'Scotiabank',
  '058': 'Banregio',
  '059': 'Invex',
  '060': 'Bansi',
  '062': 'Afirme',
  '072': 'Banorte',
  '106': 'Bank of America',
  '108': 'MUFG',
  '110': 'JP Morgan',
  '112': 'Banco Monex',
  '113': 'Ve por Más',
  '127': 'Banco Azteca',
  '128': 'Autofin',
  '130': 'Compartamos',
  '132': 'Multiva',
  '133': 'Actinver',
  '135': 'Nafin',
  '136': 'Intercam Banco',
  '137': 'BanCoppel',
  '140': 'Consubanco',
  '143': 'CIBanco',
  '145': 'Banco Base',
  '147': 'Bankaool',
  '148': 'PagaTodo',
  '152': 'Bancrea',
  '155': 'ICBC',
  '156': 'Sabadell',
  '166': 'Banco del Bienestar',
  '168': 'Hipotecaria Federal',
  '600': 'Monex Casa de Bolsa',
  '601': 'GBM',
  '638': 'NU México',
  '646': 'STP',
  '722': 'Mercado Pago W',
};

export function resolveBank(clabe: string): { bankCode: string; bankName: string | null } {
  const bankCode = clabe.slice(0, 3);
  return { bankCode, bankName: MX_BANKS[bankCode] ?? null };
}

export type ClabeValidation =
  | { isValid: true; bankCode: string; bankName: string | null }
  | { isValid: false; error: 'CLABE must be exactly 18 digits' | 'Invalid CLABE checksum' };

/** Validates format and Modulo-10 control digit, and resolves the bank. */
export function validateClabe(clabe: string): ClabeValidation {
  if (!/^\d{18}$/.test(clabe)) return { isValid: false, error: 'CLABE must be exactly 18 digits' };
  if (clabeCheckDigit(clabe.slice(0, 17)) !== Number(clabe[17])) return { isValid: false, error: 'Invalid CLABE checksum' };
  return { isValid: true, ...resolveBank(clabe) };
}
