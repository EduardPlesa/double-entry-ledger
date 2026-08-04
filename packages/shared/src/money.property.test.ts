import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMoney,
  formatMoney,
  minorUnitDigits,
  money,
  negateMoney,
  parseMoney,
  sumMoney,
} from './money.js';

/**
 * `Money` as properties rather than as examples.
 *
 * Every amount in this system passes through this module, so a defect here is a defect
 * everywhere at once - and it would surface in the database properties three layers away from
 * its cause, as a disagreement nobody could read. These run in microseconds and there is no
 * reason not to run a lot of them.
 *
 * The currencies are chosen for their minor-unit digits, not their popularity: JPY has none,
 * KWD has three, EUR and USD have the two that a formatter written from one example assumes.
 */

const CURRENCY = fc.constantFrom('EUR', 'USD', 'JPY', 'KWD');

/**
 * Well past `Number.MAX_SAFE_INTEGER` in both directions. The existing `money.test.ts` pins a
 * handful of those by hand; this is the same claim over the whole range.
 */
const AMOUNT_MINOR = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });

describe('formatMoney and parseMoney', () => {
  it('round-trips every amount in every currency', () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, CURRENCY, (amountMinor, currency) => {
        const original = money(amountMinor, currency);
        const reparsed = parseMoney(formatMoney(original), currency);

        expect(reparsed.amountMinor).toBe(amountMinor);
        expect(reparsed.currency).toBe(currency);
      }),
    );
  });

  it("always emits exactly the currency's minor-unit digits", () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, CURRENCY, (amountMinor, currency) => {
        const digits = minorUnitDigits(currency);
        const formatted = formatMoney(money(amountMinor, currency));

        if (digits === 0) {
          expect(formatted).not.toContain('.');
          return;
        }

        const fraction = formatted.split('.')[1];
        expect(fraction, `no fractional part in ${formatted}`).toBeDefined();
        expect(fraction).toHaveLength(digits);
      }),
    );
  });

  it('keeps the sign of a value that rounds to zero major units', () => {
    // -0.05 EUR formats as "-0.05" and must parse back negative. Sign handling around the
    // decimal point is where a formatter written from the positive case breaks, and it breaks
    // exactly here - where the whole part is zero and the sign lives nowhere else.
    fc.assert(
      fc.property(fc.bigInt({ min: -99n, max: -1n }), (amountMinor) => {
        const formatted = formatMoney(money(amountMinor, 'EUR'));

        expect(formatted.startsWith('-')).toBe(true);
        expect(parseMoney(formatted, 'EUR').amountMinor).toBe(amountMinor);
      }),
    );
  });
});

describe('addMoney', () => {
  it('is associative', () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, AMOUNT_MINOR, AMOUNT_MINOR, CURRENCY, (a, b, c, currency) => {
        const left = addMoney(addMoney(money(a, currency), money(b, currency)), money(c, currency));
        const right = addMoney(money(a, currency), addMoney(money(b, currency), money(c, currency)));

        expect(left.amountMinor).toBe(right.amountMinor);
      }),
    );
  });

  it('is commutative', () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, AMOUNT_MINOR, CURRENCY, (a, b, currency) => {
        expect(addMoney(money(a, currency), money(b, currency)).amountMinor).toBe(
          addMoney(money(b, currency), money(a, currency)).amountMinor,
        );
      }),
    );
  });

  it('cancels against the negation', () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, CURRENCY, (amountMinor, currency) => {
        const value = money(amountMinor, currency);
        expect(addMoney(value, negateMoney(value)).amountMinor).toBe(0n);
      }),
    );
  });
});

describe('sumMoney', () => {
  it('agrees with folding addMoney', () => {
    fc.assert(
      fc.property(fc.array(AMOUNT_MINOR, { maxLength: 20 }), CURRENCY, (amounts, currency) => {
        const values = amounts.map((amount) => money(amount, currency));
        const folded = values.reduce((total, value) => addMoney(total, value), money(0n, currency));

        expect(sumMoney(values, currency).amountMinor).toBe(folded.amountMinor);
      }),
    );
  });
});
