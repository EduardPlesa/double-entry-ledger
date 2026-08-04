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
 * Up to €200.00 a leg, against an opening balance of €160.00 - a single leg can exceed the
 * whole opening balance on its own, not merely dent it.
 *
 * Chosen so refusals happen because the generator aimed at them: a handful of entries can spend
 * the account down, and the sequences that overdraw it are common enough to exercise the rule
 * without being so common that nothing else gets tested.
 *
 * The other half of the pair `OPENING_MINOR` (`fixture.ts`) was measured against. Changing this
 * value without redoing that measurement can flip the coverage tally's `accepted > refused`
 * assertion in `ledger.property.test.ts` from a reliable pass to a flaky one, or the reverse.
 */
const MAX_LEG_MINOR = 20_000n;

/**
 * An account by its position in the book's account list, not by id.
 *
 * The account list itself - six accounts, this order, these currencies - is the same for every
 * generated case; only the ids inside it differ, and those are assigned by Postgres when a
 * case's book is seeded, long after this arbitrary is built. Carrying an index instead of an id
 * is what lets `ledgerCommands` be built once, from the fixture's fixed shape, rather than once
 * per case from that case's real accounts - see `ledger.property.test.ts`. The index is resolved
 * against the real book's account list at the point a command runs, where that list exists.
 */
export interface LegSpec {
  readonly accountIndex: number;
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface EntrySpec {
  readonly occurredAt: string;
  readonly description: string;
  readonly legs: readonly LegSpec[];
}

/**
 * An entry, in one currency or in two, always balanced within each.
 *
 * `accounts` only needs to carry the book's shape - how many accounts, in what order, in which
 * currency - not real ids: this can be, and in `ledger.property.test.ts` is, a book seeded once
 * purely to learn that shape, reused for every generated case.
 */
export function entrySpec(accounts: readonly AccountRecord[]): fc.Arbitrary<EntrySpec> {
  const currencies = [...new Set(accounts.map((account) => account.currency))].sort();

  const slots = accounts.map((account, index) => ({ index, currency: account.currency }));
  const groups = currencies.map((currency) =>
    balancedGroup(slots.filter((slot) => slot.currency === currency)),
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

/** A position in the book's account list, tagged with that account's currency. */
interface AccountSlot {
  readonly index: number;
  readonly currency: string;
}

/**
 * Two to four accounts of one currency, with amounts summing to zero and no zero leg.
 *
 * The last leg is the negation of the others, which is how a balanced entry gets generated
 * without a filter that rejects almost everything. A zero on any of the leading legs is nudged
 * to 1 rather than filtered out, because `postEntry` refuses a zero leg and a filter here would
 * throw away most of the sample.
 */
function balancedGroup(inCurrency: readonly AccountSlot[]): fc.Arbitrary<LegSpec[]> {
  const currency = inCurrency[0]?.currency ?? 'EUR';
  const indices = inCurrency.map((slot) => slot.index);

  return fc
    .uniqueArray(fc.constantFrom(...indices), {
      minLength: 2,
      maxLength: Math.min(4, indices.length),
    })
    .chain((chosenIndices) =>
      fc
        .array(fc.bigInt({ min: -MAX_LEG_MINOR, max: MAX_LEG_MINOR }), {
          minLength: chosenIndices.length - 1,
          maxLength: chosenIndices.length - 1,
        })
        .map((heads) => {
          const leading = heads.map((amount) => (amount === 0n ? 1n : amount));
          const last = -leading.reduce((total, amount) => total + amount, 0n);

          return { chosenIndices, amounts: [...leading, last] };
        }),
    )
    // Only the closing leg can still be zero: it is zero exactly when the leading legs already
    // cancel. Rare, and cheaper to discard than to reshape.
    .filter(({ amounts }) => amounts.every((amount) => amount !== 0n))
    .map(({ chosenIndices, amounts }) =>
      chosenIndices.map((accountIndex, index) => ({
        accountIndex,
        amountMinor: amounts[index] as bigint,
        currency,
      })),
    );
}

/**
 * The spec as the service's input: amounts as decimal strings, never as numbers.
 *
 * `accounts` here is the real, per-case book - unlike the shape passed to `entrySpec`, this one
 * has to carry real ids, because this is the point a generated index finally becomes a request
 * the service can act on.
 */
export function toPostEntryInput(
  spec: EntrySpec,
  accounts: readonly AccountRecord[],
): PostEntryInput {
  return {
    occurredAt: spec.occurredAt,
    description: spec.description,
    legs: spec.legs.map((leg) => {
      const account = accounts[leg.accountIndex];
      if (account === undefined) {
        throw new Error(`no account at index ${leg.accountIndex.toString()}`);
      }
      return {
        accountId: account.id,
        amount: formatMoney(money(leg.amountMinor, leg.currency)),
        currency: leg.currency,
      };
    }),
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
    const account = model.accounts[leg.accountIndex];
    return account !== undefined && isGuardedAccountType(account.type) && leg.amountMinor < 0n;
  });
}
