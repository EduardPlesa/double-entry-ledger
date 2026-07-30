/**
 * Money.
 *
 * An amount is a `bigint` count of minor units plus the currency those units belong to.
 * There is no other representation of money in this system, and there is deliberately no
 * way to get one: nothing here accepts or returns a JS `number`, so no rounding error can
 * enter through this module. `0.1 + 0.2` is a bug the type system can prevent, and this is
 * where it prevents it.
 *
 * Minor units, not decimals, because the minor unit is what the ledger actually stores and
 * what the database sums. The decimal form is presentation - a string at the edges of the
 * system, converted here, once, on the way in and on the way out.
 */

/** The database enforces the same shape with a CHECK constraint on every currency column. */
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * A decimal amount: optional sign, at least one integer digit, optional fractional part.
 *
 * No exponent notation, no thousands separators, no bare `.5`, no whitespace. A ledger
 * that guesses what an ambiguous amount meant is worse than one that refuses it, and every
 * one of those forms is either ambiguous or a sign the caller is formatting for humans on
 * the wrong side of the boundary.
 */
const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** Currencies whose minor unit is the major unit: no fractional part exists at all. */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW',
  'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Currencies with three decimal places, mostly Gulf dinars. */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export interface Money {
  /** Signed count of minor units. Negative is a credit, positive a debit. */
  readonly amountMinor: bigint;
  /** Uppercase ISO 4217 alphabetic code. */
  readonly currency: string;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export class CurrencyMismatchError extends MoneyError {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`cannot combine ${left} and ${right}: amounts in different currencies are not comparable`);
  }
}

/**
 * How many decimal places this currency's minor unit implies.
 *
 * ISO 4217 assigns this per currency and it is not two everywhere: JPY has no minor unit,
 * KWD has three. Hardcoding two would make a 1000-fils Kuwaiti amount a 10-dinar one, which
 * is the kind of error that reconciles perfectly and is wrong by a factor of a hundred.
 *
 * The table only covers the currencies that differ from the default; anything unlisted is
 * two. That is a deliberate soft failure: an exhaustive table would need maintaining
 * against ISO revisions, and the exponent only ever affects the string form, never the
 * stored amount or any sum computed from it.
 */
export function minorUnitDigits(currency: string): number {
  const code = assertCurrency(currency);
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

function assertCurrency(currency: string): string {
  if (!CURRENCY_RE.test(currency)) {
    throw new MoneyError(`invalid currency code ${JSON.stringify(currency)}: expected three uppercase letters`);
  }
  return currency;
}

/** Builds a Money from a minor-unit amount already held as a bigint. */
export function money(amountMinor: bigint, currency: string): Money {
  return { amountMinor, currency: assertCurrency(currency) };
}

export function zero(currency: string): Money {
  return money(0n, currency);
}

/**
 * Parses a decimal string - `"12.34"`, `"-0.05"`, `"1000"` - into minor units.
 *
 * Fewer decimal places than the currency has are padded, which makes `"12"` and `"12.00"`
 * the same EUR amount. *More* are rejected rather than rounded: the caller is the only one
 * who knows whether a half-cent should go up, down or to a rounding account, and silently
 * picking for them is how a ledger drifts by amounts too small to notice and too many to
 * find.
 */
export function parseMoney(decimal: string, currency: string): Money {
  const code = assertCurrency(currency);
  const digits = minorUnitDigits(code);

  const match = DECIMAL_RE.exec(decimal);
  if (match === null) {
    throw new MoneyError(
      `invalid amount ${JSON.stringify(decimal)}: expected a decimal string such as "12.34"`,
    );
  }

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > digits) {
    throw new MoneyError(
      `amount ${JSON.stringify(decimal)} has ${String(fraction.length)} decimal places, but ${code} has ${String(digits)}`,
    );
  }

  // String concatenation, not multiplication: padding the fraction to the currency's scale
  // and gluing it to the integer part *is* the conversion to minor units, and it stays
  // exact for values of any size because BigInt() parses the whole thing at once.
  const magnitude = BigInt(`${whole ?? '0'}${fraction.padEnd(digits, '0')}`);

  return { amountMinor: sign === '-' ? -magnitude : magnitude, currency: code };
}

/** Parses a minor-unit integer string, the form amounts take on the wire to the database. */
export function parseMoneyMinor(minorUnits: string, currency: string): Money {
  if (!/^[+-]?\d+$/.test(minorUnits)) {
    throw new MoneyError(
      `invalid minor-unit amount ${JSON.stringify(minorUnits)}: expected an integer string`,
    );
  }
  return money(BigInt(minorUnits), currency);
}

/**
 * Renders minor units as a decimal string with exactly the currency's number of places.
 *
 * Division and remainder on bigints, so a value past `Number.MAX_SAFE_INTEGER` formats
 * exactly rather than approximately. `toLocaleString` and friends are absent on purpose:
 * this is the canonical machine-readable form, and locale-aware display belongs in the
 * frontend, where the locale is known.
 */
export function formatMoney(value: Money): string {
  const digits = minorUnitDigits(value.currency);
  const negative = value.amountMinor < 0n;
  const magnitude = negative ? -value.amountMinor : value.amountMinor;
  const sign = negative ? '-' : '';

  if (digits === 0) return `${sign}${magnitude.toString()}`;

  const scale = 10n ** BigInt(digits);
  const whole = magnitude / scale;
  const fraction = magnitude % scale;

  return `${sign}${whole.toString()}.${fraction.toString().padStart(digits, '0')}`;
}

function assertSameCurrency(left: Money, right: Money): string {
  if (left.currency !== right.currency) {
    throw new CurrencyMismatchError(left.currency, right.currency);
  }
  return left.currency;
}

export function addMoney(left: Money, right: Money): Money {
  return { amountMinor: left.amountMinor + right.amountMinor, currency: assertSameCurrency(left, right) };
}

export function subtractMoney(left: Money, right: Money): Money {
  return { amountMinor: left.amountMinor - right.amountMinor, currency: assertSameCurrency(left, right) };
}

/** The other side of a leg. What a reversal does to every posting of an entry. */
export function negateMoney(value: Money): Money {
  return { amountMinor: -value.amountMinor, currency: value.currency };
}

export function absMoney(value: Money): Money {
  return value.amountMinor < 0n ? negateMoney(value) : value;
}

/**
 * Sums a sequence in a single currency. The currency is a parameter rather than something
 * inferred from the first element, because the sum of an empty sequence is zero in some
 * currency and the caller is the one who knows which.
 */
export function sumMoney(values: Iterable<Money>, currency: string): Money {
  const code = assertCurrency(currency);
  let total = 0n;
  for (const value of values) {
    if (value.currency !== code) throw new CurrencyMismatchError(code, value.currency);
    total += value.amountMinor;
  }
  return { amountMinor: total, currency: code };
}

/** -1, 0 or 1. Returned as a number because an ordering is not an amount. */
export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  if (left.amountMinor < right.amountMinor) return -1;
  if (left.amountMinor > right.amountMinor) return 1;
  return 0;
}

export function equalsMoney(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.amountMinor === right.amountMinor;
}

export function isZeroMoney(value: Money): boolean {
  return value.amountMinor === 0n;
}

export function isNegativeMoney(value: Money): boolean {
  return value.amountMinor < 0n;
}
