import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  MoneyError,
  addMoney,
  compareMoney,
  equalsMoney,
  formatMoney,
  isNegativeMoney,
  isZeroMoney,
  minorUnitDigits,
  money,
  negateMoney,
  parseMoney,
  parseMoneyMinor,
  subtractMoney,
  sumMoney,
  zero,
} from './money.js';

/**
 * One cent past what a JS number can represent exactly. 2^53 is the last integer with a
 * unique double; 2^53 + 1 is not representable and rounds to 2^53. Any implementation that
 * lets a number touch an amount fails on these values, which is the point of asserting on
 * them rather than on 12.34.
 */
const BEYOND_SAFE = 9_007_199_254_740_993n;

describe('minorUnitDigits', () => {
  it('is two by default', () => {
    expect(minorUnitDigits('EUR')).toBe(2);
    expect(minorUnitDigits('USD')).toBe(2);
    expect(minorUnitDigits('ZZZ')).toBe(2);
  });

  it('is zero for currencies without a minor unit', () => {
    expect(minorUnitDigits('JPY')).toBe(0);
    expect(minorUnitDigits('ISK')).toBe(0);
  });

  it('is three for the Gulf dinars', () => {
    expect(minorUnitDigits('KWD')).toBe(3);
    expect(minorUnitDigits('BHD')).toBe(3);
  });

  it('rejects anything that is not a three-letter code', () => {
    expect(() => minorUnitDigits('eur')).toThrow(MoneyError);
    expect(() => minorUnitDigits('EURO')).toThrow(MoneyError);
    expect(() => minorUnitDigits('')).toThrow(MoneyError);
  });
});

describe('parseMoney', () => {
  it('converts a decimal string to minor units', () => {
    expect(parseMoney('12.34', 'EUR').amountMinor).toBe(1234n);
    expect(parseMoney('0.05', 'EUR').amountMinor).toBe(5n);
    expect(parseMoney('-0.05', 'EUR').amountMinor).toBe(-5n);
    expect(parseMoney('+7.00', 'EUR').amountMinor).toBe(700n);
  });

  it('pads a short or absent fraction to the currency scale', () => {
    expect(parseMoney('12', 'EUR').amountMinor).toBe(1200n);
    expect(parseMoney('12.3', 'EUR').amountMinor).toBe(1230n);
    expect(parseMoney('12.3', 'KWD').amountMinor).toBe(12300n);
  });

  it('honours currencies whose scale is not two', () => {
    expect(parseMoney('1000', 'JPY').amountMinor).toBe(1000n);
    expect(parseMoney('1.234', 'KWD').amountMinor).toBe(1234n);
  });

  it('rejects more decimal places than the currency has, rather than rounding', () => {
    expect(() => parseMoney('12.345', 'EUR')).toThrow(/2 decimal places|has 3 decimal/);
    expect(() => parseMoney('1000.5', 'JPY')).toThrow(MoneyError);
  });

  it('rejects forms that are ambiguous or already formatted for a human', () => {
    for (const bad of ['', ' 12.34', '12.34 ', '1,234.00', '1e3', '.5', '12.', '--1', 'twelve']) {
      expect(() => parseMoney(bad, 'EUR'), bad).toThrow(MoneyError);
    }
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    const parsed = parseMoney('90071992547409.93', 'EUR');
    expect(parsed.amountMinor).toBe(BEYOND_SAFE);

    // The same value through a double loses the last cent. This is the failure the bigint
    // is here to prevent, asserted so the reason stays visible. The lint rule below is
    // suppressed rather than obeyed: losing precision is the assertion.
    // eslint-disable-next-line no-loss-of-precision
    expect(BigInt(Math.round(90_071_992_547_409.93 * 100))).not.toBe(BEYOND_SAFE);
  });

  it('parses amounts far past any float, exactly', () => {
    const huge = '123456789012345678901234567890.99';
    expect(parseMoney(huge, 'EUR').amountMinor).toBe(12345678901234567890123456789099n);
  });
});

describe('parseMoneyMinor', () => {
  it('reads the integer form the database uses', () => {
    expect(parseMoneyMinor('1234', 'EUR').amountMinor).toBe(1234n);
    expect(parseMoneyMinor('-1234', 'EUR').amountMinor).toBe(-1234n);
    expect(parseMoneyMinor(BEYOND_SAFE.toString(), 'EUR').amountMinor).toBe(BEYOND_SAFE);
  });

  it('rejects a decimal string, which would silently mean something else', () => {
    expect(() => parseMoneyMinor('12.34', 'EUR')).toThrow(MoneyError);
  });
});

describe('formatMoney', () => {
  it('round-trips the decimal form', () => {
    for (const [text, currency] of [
      ['12.34', 'EUR'],
      ['-0.05', 'EUR'],
      ['0.00', 'EUR'],
      ['1000', 'JPY'],
      ['1.234', 'KWD'],
    ] as const) {
      expect(formatMoney(parseMoney(text, currency))).toBe(text);
    }
  });

  it('pads the fraction to the currency scale', () => {
    expect(formatMoney(money(5n, 'EUR'))).toBe('0.05');
    expect(formatMoney(money(-5n, 'EUR'))).toBe('-0.05');
    expect(formatMoney(money(1200n, 'EUR'))).toBe('12.00');
    expect(formatMoney(money(7n, 'KWD'))).toBe('0.007');
    expect(formatMoney(money(7n, 'JPY'))).toBe('7');
  });

  it('is exact beyond Number.MAX_SAFE_INTEGER', () => {
    expect(formatMoney(money(BEYOND_SAFE, 'EUR'))).toBe('90071992547409.93');
    expect(formatMoney(money(-BEYOND_SAFE, 'EUR'))).toBe('-90071992547409.93');
    expect(formatMoney(money(BEYOND_SAFE, 'JPY'))).toBe('9007199254740993');
  });
});

describe('arithmetic', () => {
  it('adds and subtracts within a currency', () => {
    expect(addMoney(money(1234n, 'EUR'), money(-234n, 'EUR')).amountMinor).toBe(1000n);
    expect(subtractMoney(money(1234n, 'EUR'), money(234n, 'EUR')).amountMinor).toBe(1000n);
  });

  it('stays exact where a double would not', () => {
    const total = addMoney(money(BEYOND_SAFE, 'EUR'), money(1n, 'EUR'));
    expect(total.amountMinor).toBe(9_007_199_254_740_994n);
    expect(subtractMoney(total, money(BEYOND_SAFE, 'EUR')).amountMinor).toBe(1n);
  });

  it('refuses to combine currencies', () => {
    expect(() => addMoney(money(1n, 'EUR'), money(1n, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => subtractMoney(money(1n, 'EUR'), money(1n, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => compareMoney(money(1n, 'EUR'), money(1n, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('negates', () => {
    expect(negateMoney(money(1234n, 'EUR')).amountMinor).toBe(-1234n);
    expect(negateMoney(money(0n, 'EUR')).amountMinor).toBe(0n);
  });

  it('sums a sequence, and an empty one is zero in the stated currency', () => {
    const legs = [money(1000n, 'EUR'), money(-400n, 'EUR'), money(-600n, 'EUR')];
    expect(sumMoney(legs, 'EUR')).toEqual(zero('EUR'));
    expect(sumMoney([], 'JPY')).toEqual(money(0n, 'JPY'));
  });

  it('sums exactly across values a double could not hold', () => {
    const legs = [money(BEYOND_SAFE, 'EUR'), money(BEYOND_SAFE, 'EUR'), money(-2n * BEYOND_SAFE, 'EUR')];
    expect(isZeroMoney(sumMoney(legs, 'EUR'))).toBe(true);
  });

  it('refuses a sequence carrying a foreign currency', () => {
    expect(() => sumMoney([money(1n, 'EUR'), money(1n, 'USD')], 'EUR')).toThrow(CurrencyMismatchError);
  });

  it('orders and compares', () => {
    expect(compareMoney(money(1n, 'EUR'), money(2n, 'EUR'))).toBe(-1);
    expect(compareMoney(money(2n, 'EUR'), money(1n, 'EUR'))).toBe(1);
    expect(compareMoney(money(2n, 'EUR'), money(2n, 'EUR'))).toBe(0);
    expect(compareMoney(money(BEYOND_SAFE, 'EUR'), money(BEYOND_SAFE + 1n, 'EUR'))).toBe(-1);

    expect(equalsMoney(money(1n, 'EUR'), money(1n, 'EUR'))).toBe(true);
    expect(equalsMoney(money(1n, 'EUR'), money(1n, 'USD'))).toBe(false);

    expect(isNegativeMoney(money(-1n, 'EUR'))).toBe(true);
    expect(isNegativeMoney(zero('EUR'))).toBe(false);
  });
});
