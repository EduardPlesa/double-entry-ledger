import {
  formatMoney,
  isZeroMoney,
  negateMoney,
  parseMoney,
  sumMoney,
  type AccountResource,
  type Money,
} from '@ledger/shared';

/**
 * Whether an entry balances, and by how much - as functions over values.
 *
 * No React here on purpose. The rule that greys out the submit button is the same rule the
 * database enforces in a deferred constraint trigger, and it deserves to be checked directly
 * rather than through a rendered form. Everything the composer decides, it decides here.
 *
 * Debits are positive and credits negative. The API takes one signed amount per leg, which is
 * the right boundary; two columns are what a person keeping books expects to type into, and
 * the sign is derived from which column they used rather than from a character they might
 * forget.
 */

export interface LegRow {
  readonly accountId: string;
  readonly debit: string;
  readonly credit: string;
}

export type LegProblem = 'no-account' | 'both-columns' | 'no-amount' | 'unparseable' | 'zero';

export type AccountsById = ReadonlyMap<string, AccountResource>;

/** What is wrong with this row, or null if nothing is. */
export function legProblem(row: LegRow, currency: string | null): LegProblem | null {
  if (row.accountId === '' || currency === null) return 'no-account';

  const debit = row.debit.trim();
  const credit = row.credit.trim();

  if (debit !== '' && credit !== '') return 'both-columns';
  if (debit === '' && credit === '') return 'no-amount';

  const amount = tryParse(debit === '' ? credit : debit, currency);
  if (amount === null) return 'unparseable';

  // A zero leg carries no accounting meaning, and `postings_amount_nonzero` rejects it. Saying
  // so here costs a glance; discovering it at the server costs a round trip and a worse message.
  if (isZeroMoney(amount)) return 'zero';

  return null;
}

/** The row as the API wants it: one signed amount. Null when the row is not usable. */
export function signedAmount(row: LegRow, currency: string): Money | null {
  if (legProblem(row, currency) !== null) return null;

  const debit = row.debit.trim();
  const parsed = tryParse(debit === '' ? row.credit.trim() : debit, currency);
  if (parsed === null) return null;

  return debit === '' ? negateMoney(parsed) : parsed;
}

/**
 * One delta per currency present, debits minus credits, in the order the currencies first
 * appear. Balanced currencies are included rather than filtered out: "EUR balanced" beside
 * "USD unbalanced by 3.00" is what tells someone the EUR half is done.
 *
 * Rows that cannot be read yet are skipped rather than treated as errors, so the strip keeps
 * updating while a number is half-typed.
 */
export function imbalances(
  rows: readonly LegRow[],
  accountsById: AccountsById,
): { currency: string; delta: Money }[] {
  const byCurrency = new Map<string, Money[]>();

  for (const row of rows) {
    const currency = currencyOf(row, accountsById);
    if (currency === null) continue;

    const amount = signedAmount(row, currency);
    const amounts = byCurrency.get(currency) ?? [];
    byCurrency.set(currency, amount === null ? amounts : [...amounts, amount]);
  }

  return [...byCurrency].map(([currency, amounts]) => ({
    currency,
    delta: sumMoney(amounts, currency),
  }));
}

/** Whether the form may be submitted. Every condition, in one place. */
export function canSubmit(rows: readonly LegRow[], accountsById: AccountsById): boolean {
  if (rows.length < 2) return false;

  for (const row of rows) {
    if (legProblem(row, currencyOf(row, accountsById)) !== null) return false;
  }

  return imbalances(rows, accountsById).every((entry) => isZeroMoney(entry.delta));
}

/**
 * What to put in this row's empty cell to bring its currency to zero.
 *
 * The operation someone performs by hand on every journal they write. Returns a magnitude as a
 * decimal string; which column it belongs in is the caller's business, and follows from the
 * sign of the outstanding delta.
 */
export function remainderFor(
  rows: readonly LegRow[],
  accountsById: AccountsById,
  index: number,
): string | null {
  const row = rows[index];
  if (row === undefined) return null;

  const currency = currencyOf(row, accountsById);
  if (currency === null) return null;

  const others = rows.filter((_, position) => position !== index);
  const delta = imbalances(others, accountsById).find((entry) => entry.currency === currency);

  if (delta === undefined || isZeroMoney(delta.delta)) return null;

  return formatMoney(absolute(delta.delta));
}

/** Which column `remainderFor`'s value belongs in: a positive outstanding delta needs a credit. */
export function remainderColumn(
  rows: readonly LegRow[],
  accountsById: AccountsById,
  index: number,
): 'debit' | 'credit' | null {
  const row = rows[index];
  if (row === undefined) return null;

  const currency = currencyOf(row, accountsById);
  if (currency === null) return null;

  const others = rows.filter((_, position) => position !== index);
  const delta = imbalances(others, accountsById).find((entry) => entry.currency === currency);

  if (delta === undefined || isZeroMoney(delta.delta)) return null;

  return delta.delta.amountMinor > 0n ? 'credit' : 'debit';
}

export function currencyOf(row: LegRow, accountsById: AccountsById): string | null {
  return accountsById.get(row.accountId)?.currency ?? null;
}

function absolute(value: Money): Money {
  return value.amountMinor < 0n ? negateMoney(value) : value;
}

/** `parseMoney` throws on anything it does not like; here that is an answer, not a failure. */
function tryParse(text: string, currency: string): Money | null {
  try {
    return parseMoney(text, currency);
  } catch {
    return null;
  }
}
