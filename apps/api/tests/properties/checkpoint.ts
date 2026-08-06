import { expect } from 'vitest';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import type { PropertyBook } from './fixture.js';

/**
 * The two paths agree, for every account, whatever happened.
 *
 * Not a comparison against the model: both numbers come from the database. The model already
 * pins what the balance *should* be; this pins that the fast path and the slow path cannot
 * disagree about it - which is the only failure mode a checkpoint introduces, and the one a
 * date-keyed checkpoint would exhibit the moment a backdated entry arrived.
 *
 * Read in one transaction per account so the two sums see the same snapshot. Across two
 * transactions a concurrent write could land between them and produce a difference that is
 * not a bug.
 */

const repository = new DrizzleLedgerRepository();

export async function assertCheckpointAgreement(book: PropertyBook): Promise<void> {
  for (const account of book.accounts) {
    const [viaCheckpoint, fromZero] = await book.unitOfWork.transactionInBook(
      book.bookId,
      async (tx) => {
        const checkpoint = await repository.latestCheckpoint(tx, account.id);
        const resumed =
          checkpoint === null
            ? await repository.sumPostings(tx, account.id)
            : checkpoint.balanceMinor +
              (await repository.sumPostingsAfter(tx, account.id, checkpoint.throughId));

        return [resumed, await repository.sumPostings(tx, account.id)];
      },
    );

    expect(viaCheckpoint, `checkpointed balance of ${account.name}`).toBe(fromZero);
  }
}
