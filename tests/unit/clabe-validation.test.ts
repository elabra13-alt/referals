import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MX_BANKS, clabeCheckDigit, isValidClabe, maskClabe, resolveBank, validateClabe } from '../../src/lib/clabe.js';

/** The reference algorithm exactly as written in the task spec. */
const SPEC_WEIGHTS = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7];
function specControlDigit(first17: string): number {
  const sum = first17
    .split('')
    .map(Number)
    .reduce((acc, digit, idx) => acc + ((digit * SPEC_WEIGHTS[idx]!) % 10), 0);
  return (10 - (sum % 10)) % 10;
}

/** Builds a valid CLABE for a bank code by computing its control digit. */
const makeClabe = (bank: string, rest = '18000011835971') => {
  const first17 = `${bank}${rest}`.slice(0, 17);
  return `${first17}${clabeCheckDigit(first17)}`;
};

describe('CLABE control digit (Modulo-10, weights 3-7-1)', () => {
  it('matches the spec’s reference algorithm on 5,000 random accounts', () => {
    for (let i = 0; i < 5_000; i++) {
      const first17 = Array.from({ length: 17 }, () => randomInt(10)).join('');
      expect(clabeCheckDigit(first17)).toBe(specControlDigit(first17));
    }
  });

  it.each([
    ['002010077777777771', '002', 'Banamex'],
    ['014027000005555558', '014', 'Santander'],
  ])('accepts published valid CLABE %s (%s %s)', (clabe, bankCode, bankName) => {
    expect(validateClabe(clabe)).toEqual({ isValid: true, bankCode, bankName });
    expect(isValidClabe(clabe)).toBe(true);
  });

  it('rejects every single-digit change to the control digit', () => {
    const valid = '002010077777777771';
    for (let d = 0; d <= 9; d++) {
      const candidate = `${valid.slice(0, 17)}${d}`;
      if (candidate === valid) continue;
      expect(validateClabe(candidate)).toEqual({ isValid: false, error: 'Invalid CLABE checksum' });
    }
  });

  it('catches a typo in the account digits', () => {
    expect(validateClabe('002010077777777871')).toEqual({ isValid: false, error: 'Invalid CLABE checksum' });
  });
});

describe('format errors', () => {
  it.each([
    ['17 digits', '00201007777777777'],
    ['19 digits', '0020100777777777710'],
    ['letters', '00201007777777777A'],
    ['spaces (callers must normalize first)', '002 010 07777777777 1'],
    ['empty', ''],
  ])('rejects %s', (_label, clabe) => {
    expect(validateClabe(clabe)).toEqual({ isValid: false, error: 'CLABE must be exactly 18 digits' });
    expect(isValidClabe(clabe)).toBe(false);
  });
});

describe('bank code resolver', () => {
  it.each([
    ['012', 'BBVA México'],
    ['002', 'Banamex'],
    ['014', 'Santander'],
    ['021', 'HSBC'],
    ['072', 'Banorte'],
    ['127', 'Banco Azteca'],
    ['137', 'BanCoppel'],
    ['646', 'STP'],
    ['638', 'NU México'],
    ['722', 'Mercado Pago W'],
  ])('resolves %s to %s', (bank, name) => {
    const clabe = makeClabe(bank);
    expect(validateClabe(clabe)).toEqual({ isValid: true, bankCode: bank, bankName: name });
    expect(resolveBank(clabe)).toEqual({ bankCode: bank, bankName: name });
  });

  it('maps STP to 646 (not 638, which is NU México)', () => {
    expect(MX_BANKS['646']).toBe('STP');
    expect(MX_BANKS['638']).not.toBe('STP');
  });

  it('accepts a checksum-valid CLABE from a bank outside the catalog, without a name', () => {
    expect(validateClabe(makeClabe('999'))).toEqual({ isValid: true, bankCode: '999', bankName: null });
  });

  it('only ever exposes the last 4 digits', () => {
    expect(maskClabe('002010077777777771')).toBe('**************7771');
  });
});
