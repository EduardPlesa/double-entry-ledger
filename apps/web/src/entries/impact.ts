import { addMoney, negateMoney, parseMoney, zero, type EntryResource, type Money } from '@ledger/shared';

/**
 * What a reversal would do to each account it touches.
 *
 * The arithmetic is certain: a reversal posts the negation of every leg, so the delta is exactly
 * `-leg`. What it cannot promise is acceptance. Reversals are not exempt from the overdraft
 * rule - an entry that cannot be reversed without leaving a guarded account negative is one
 * whose reversal alone is not the correction - and the rule is evaluated at commit, over every
 * prefix of the account's history, which another writer may have moved since this was drawn.
 */
export function impactOf(
  entry: EntryResource,
  balancesById: ReadonlyMap<string, Money>,
): { accountId: string; before: Money; delta: Money; after: Money }[] {
  return entry.postings.map((posting) => {
    const before = balancesById.get(posting.accountId) ?? zero(posting.currency);
    const delta = negateMoney(parseMoney(posting.amount, posting.currency));

    return { accountId: posting.accountId, before, delta, after: addMoney(before, delta) };
  });
}
