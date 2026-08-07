/**
 * Refreshes every checkpoint in a book.
 *
 * A script and not a scheduler - nothing runs this automatically, and that is a real gap but
 * a cheap one to carry: a stale checkpoint makes reads slower and never makes them wrong, so
 * the failure mode of never running this is exactly the performance the system had before
 * checkpoints existed.
 *
 * Built through `createApplication`, the same composition root the server uses, so this runs
 * `checkpointAccount` the way the application would - not a hand-assembled service that
 * happens to compile. `checkpointAccount` itself stays off the write path; this script is the
 * only caller outside tests.
 */
import { formatMoney } from '@ledger/shared';
import { createApplication } from '../src/composition.js';
import { CheckpointRequiresRowLockError } from '../src/services/ledger.service.js';

const bookId = process.argv[2];

if (bookId === undefined) {
  process.stderr.write('usage: pnpm --filter @ledger/api checkpoint <bookId>\n');
  process.exitCode = 1;
} else {
  const app = createApplication();

  try {
    const accounts = await app.ledger.listAccounts(bookId);

    for (const account of accounts) {
      const result = await app.ledger.checkpointAccount(bookId, account.id);
      const status = result.written ? 'written' : 'unchanged';

      process.stdout.write(
        `${result.accountId} ${formatMoney(result.balance)} through ${result.throughId.toString()} (${status})\n`,
      );
    }
  } catch (error) {
    // The one refusal this script anticipates: a message telling the operator what to do,
    // not a stack trace telling them where in the codebase it happened. Anything else is a
    // bug, and a bug is exactly what should keep its stack trace.
    if (error instanceof CheckpointRequiresRowLockError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    // A script that leaves a pool open never exits - see db/migrate.ts for the same rule.
    await app.close();
  }
}
