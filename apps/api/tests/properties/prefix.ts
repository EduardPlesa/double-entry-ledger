import { expect } from 'vitest';
import type { UnitOfWork } from '../../src/db/client.js';
import { isGuardedAccountType } from '../../src/domain/overdraft.js';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import type { LedgerModel } from './model.js';

/**
 * Invariant 4: no guarded account's minimum running balance is below zero, ever.
 *
 * Checked twice, by independent means. The model scans an array in `(occurredAt, seq)` order;
 * `lowestPrefixBalance` computes the same thing with a SQL window function over
 * `(occurred_at, id)`. That is not the rule written twice - it is one total order arrived at
 * two ways, and since the generator makes ties at equal `occurredAt` common on purpose, it is
 * the assertion that pins the tiebreaker stage 4's design argued for.
 */

const repository = new DrizzleLedgerRepository();

export async function assertGuardedPrefixes(
  model: LedgerModel,
  context: { bookId: string; unitOfWork: UnitOfWork },
): Promise<void> {
  for (const account of model.accounts) {
    if (!isGuardedAccountType(account.type)) continue;

    const expected = model.lowestPrefix(account.id);

    const actual = await context.unitOfWork.transactionInBook(context.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, account.id),
    );

    if (expected === null) {
      expect(actual, `${account.name} has no postings in the model`).toBeNull();
      continue;
    }

    expect(actual, `${account.name} has postings in the model but none in the database`).not.toBeNull();
    expect(actual?.balanceMinor, `lowest prefix of ${account.name}`).toBe(expected.balanceMinor);
    expect(actual?.occurredAt.getTime(), `when ${account.name} is lowest`).toBe(
      expected.occurredAt.getTime(),
    );

    expect(expected.balanceMinor, `${account.name} went overdrawn`).toBeGreaterThanOrEqual(0n);
  }
}
