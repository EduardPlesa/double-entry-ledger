import { expect } from 'vitest';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import type { PropertyBook } from './fixture.js';

/**
 * The two paths agree, for every account, whatever happened.
 *
 * "The two paths" means the production ones: `LedgerService.getBalance` - which internally
 * calls the private `balanceThrough` and takes whichever branch a checkpoint's presence and
 * watermark dictate - compared against a sum from zero read straight off `postings`. An
 * earlier version of this function reimplemented `balanceThrough`'s composition by hand
 * instead of calling it, which agreed with itself by construction and was blind to a bug
 * living inside `balanceThrough` itself. Calling `getBalance` is what makes such a bug
 * visible here, and is the whole reason this file exists rather than trusting the repository
 * property below on its own.
 *
 * `getBalance` opens its own book-scoped transaction - the service accepts no transaction
 * from a caller - so the two reads below run as two separate transactions rather than one.
 * That is still safe here because this is a single-actor test: nothing else writes to this
 * book between the two `await`s, so both transactions see the same committed state. Decision
 * 1's original concern - a concurrent write landing between two reads - does not arise when
 * there is no concurrent writer, which every generated case guarantees by construction (one
 * book, one caller, driven sequentially).
 *
 * A second, independent derivation follows the service comparison: the same "checkpoint plus
 * delta" composition, rebuilt directly from the repository primitives rather than through the
 * service, read inside one transaction so nothing can land between its own two sums. It is
 * narrower than the service comparison above - blind to a bug in which branch the service
 * picks - but catches a bug in the range a checkpoint resumes from (an off-by-one in
 * `sumPostingsAfter`, say) with nothing standing between the assertion and the SQL.
 */

const repository = new DrizzleLedgerRepository();

export async function assertCheckpointAgreement(book: PropertyBook): Promise<void> {
  for (const account of book.accounts) {
    // The production path.
    const viaService = await book.service.getBalance(book.bookId, account.id);
    const fromZero = await book.unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.sumPostings(tx, account.id),
    );

    expect(
      viaService.balance.amountMinor,
      `checkpointed balance of ${account.name} (service path, via getBalance/balanceThrough)`,
    ).toBe(fromZero);

    // The repository-level cross-check, independent of the service.
    const [viaCheckpoint, fromZeroAgain] = await book.unitOfWork.transactionInBook(
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

    expect(
      viaCheckpoint,
      `checkpointed balance of ${account.name} (repository path)`,
    ).toBe(fromZeroAgain);
  }
}
