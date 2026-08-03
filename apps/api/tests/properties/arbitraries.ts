import { formatMoney, money } from '@ledger/shared';
import fc from 'fast-check';
import { isGuardedAccountType } from '../../src/domain/overdraft.js';
import type { AccountRecord } from '../../src/repositories/ledger.repository.js';
import type { PostEntryInput } from '../../src/services/ledger.service.js';
import type { LedgerModel } from './model.js';

/**
 * Entries a generator can produce that the service should never refuse on grounds of shape.
 *
 * Every leg names a real account in the book, carries that account's own currency, is non-zero,
 * and each currency group sums to zero on its own. Anything the service rejects from this
 * generator other than an overdraft is therefore a finding, not a badly-formed entry - which is
 * what lets the command harness fail loudly on every other error.
 */

/**
 * A small fixed set, deliberately.
 *
 * Backdating then happens constantly rather than occasionally, and two postings landing at the
 * same `occurredAt` is the common case rather than the rare one - which is what the prefix
 * rule's `(occurred_at, id)` tiebreaker needs in order to be tested at all. All three are after
 * the opening entry in `fixture.ts`, so an account is funded before anything draws on it.
 */
export const OCCURRED_AT_CHOICES = [
  '2026-01-15T00:00:00.000Z',
  '2026-02-15T00:00:00.000Z',
  '2026-03-15T00:00:00.000Z',
] as const;

/**
 * Up to €200.00 a leg, against an opening balance of €1,000.00.
 *
 * Chosen so refusals happen because the generator aimed at them: a handful of entries can spend
 * the account down, and the sequences that overdraw it are common enough to exercise the rule
 * without being so common that nothing else gets tested.
 */
const MAX_LEG_MINOR = 20_000n;

export interface LegSpec {
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface EntrySpec {
  readonly occurredAt: string;
  readonly description: string;
  readonly legs: readonly LegSpec[];
}

/** An entry, in one currency or in two, always balanced within each. */
export function entrySpec(accounts: readonly AccountRecord[]): fc.Arbitrary<EntrySpec> {
  const currencies = [...new Set(accounts.map((account) => account.currency))].sort();

  const groups = currencies.map((currency) =>
    balancedGroup(accounts.filter((account) => account.currency === currency)),
  );

  return fc
    .record({
      occurredAt: fc.constantFrom(...OCCURRED_AT_CHOICES),
      description: fc.constantFrom('generated entry', 'transfer', 'adjustment'),
      // At least one currency group; sometimes more, which is the per-currency zero-sum
      // invariant under generated load rather than in a hand-written case.
      chosen: fc.uniqueArray(fc.integer({ min: 0, max: groups.length - 1 }), {
        minLength: 1,
        maxLength: groups.length,
      }),
    })
    .chain(({ occurredAt, description, chosen }) =>
      fc
        .tuple(...chosen.map((index) => groups[index] as fc.Arbitrary<LegSpec[]>))
        .map((legGroups) => ({ occurredAt, description, legs: legGroups.flat() })),
    );
}

/**
 * Two to four accounts of one currency, with amounts summing to zero and no zero leg.
 *
 * The last leg is the negation of the others, which is how a balanced entry gets generated
 * without a filter that rejects almost everything. A zero on any of the leading legs is nudged
 * to 1 rather than filtered out, because `postEntry` refuses a zero leg and a filter here would
 * throw away most of the sample.
 */
function balancedGroup(inCurrency: readonly AccountRecord[]): fc.Arbitrary<LegSpec[]> {
  const currency = inCurrency[0]?.currency ?? 'EUR';
  const ids = inCurrency.map((account) => account.id);

  return fc
    .uniqueArray(fc.constantFrom(...ids), {
      minLength: 2,
      maxLength: Math.min(4, ids.length),
    })
    .chain((chosenIds) =>
      fc
        .array(fc.bigInt({ min: -MAX_LEG_MINOR, max: MAX_LEG_MINOR }), {
          minLength: chosenIds.length - 1,
          maxLength: chosenIds.length - 1,
        })
        .map((heads) => {
          const leading = heads.map((amount) => (amount === 0n ? 1n : amount));
          const last = -leading.reduce((total, amount) => total + amount, 0n);

          return { chosenIds, amounts: [...leading, last] };
        }),
    )
    // Only the closing leg can still be zero: it is zero exactly when the leading legs already
    // cancel. Rare, and cheaper to discard than to reshape.
    .filter(({ amounts }) => amounts.every((amount) => amount !== 0n))
    .map(({ chosenIds, amounts }) =>
      chosenIds.map((accountId, index) => ({
        accountId,
        amountMinor: amounts[index] as bigint,
        currency,
      })),
    );
}

/** The spec as the service's input: amounts as decimal strings, never as numbers. */
export function toPostEntryInput(spec: EntrySpec): PostEntryInput {
  return {
    occurredAt: spec.occurredAt,
    description: spec.description,
    legs: spec.legs.map((leg) => ({
      accountId: leg.accountId,
      amount: formatMoney(money(leg.amountMinor, leg.currency)),
      currency: leg.currency,
    })),
  };
}

/**
 * Whether this entry could possibly lower a guarded account's balance.
 *
 * An entry with no negative leg on a guarded account cannot: all its legs share one
 * `occurred_at`, its postings take ids above every existing row, so prefixes before its position
 * are untouched and every prefix at or after it rises. Such an entry is provably acceptable, and
 * that is what invariant 6 asserts.
 */
export function hasNegativeGuardedLeg(spec: EntrySpec, model: LedgerModel): boolean {
  return spec.legs.some((leg) => {
    const account = model.accountById(leg.accountId);
    return account !== undefined && isGuardedAccountType(account.type) && leg.amountMinor < 0n;
  });
}
