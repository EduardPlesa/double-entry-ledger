/**
 * Which accounts may not go negative.
 *
 * An account type rather than a per-account flag, and hardcoded rather than configured:
 * the rule is a fact about what an asset is - a cash box holds no negative euros - not a
 * product setting. A per-account `overdraft_limit_minor` is a later addition that changes
 * nothing about how the rule is enforced concurrently, which is what this stage is about.
 *
 * Mirrored by `guarded_account_types()` in migration 0007. That duplication is deliberate,
 * for the same reason `policy.ts` duplicates the `book_role` enum: the database has to be
 * able to enforce the rule without asking this process. `tests/db/overdraft.trigger.test.ts`
 * asserts the two agree, so the copy cannot drift.
 */

/**
 * The five account types, matching the `account_type` enum in `db/schema.ts`.
 *
 * Written out here rather than imported, so `domain/` keeps depending on nothing - the same
 * discipline `policy.ts` follows. The unit test below compares this list against the enum's
 * own values, which is what makes the structural copy safe.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/** Account types that may not hold a negative balance at any point in their history. */
export const GUARDED_ACCOUNT_TYPES = ['asset'] as const satisfies readonly AccountType[];

const GUARDED: ReadonlySet<string> = new Set(GUARDED_ACCOUNT_TYPES);

export function isGuardedAccountType(type: AccountType): boolean {
  return GUARDED.has(type);
}
