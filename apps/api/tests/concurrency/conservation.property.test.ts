import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { ConcurrencyStrategy } from '../../src/db/client.js';
import { SQLSTATE, hasSqlState } from '../../src/db/pg-errors.js';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import { fireTransfers, fundedBook, type TransferSpec } from '../helpers/concurrency.js';
import { balanceOf, queryInBook } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';
import { CONCURRENT_BATCH_EXAMPLES } from '../properties/regressions.js';

/**
 * Value conservation and the overdraft rule, over generated batches fired for real.
 *
 * `fc.scheduler` shrinks interleavings of JS `await` points, and would be the reproducible
 * option - but the thing stage 4 proved dangerous was Postgres commit ordering under READ
 * COMMITTED, which no JavaScript scheduler observes or controls. So the generator picks the
 * batch *shape* and the harness fires it over real pool connections, keeping the subject
 * intact and giving up deterministic replay.
 *
 * The outcome is legitimately nondeterministic - which transfers win is a race - so every
 * assertion here is about what must hold whichever subset commits.
 */

const OPENING = 50_000n;
const STRATEGIES: readonly ConcurrencyStrategy[] = ['row-lock', 'serializable'];

/** Low: each case is a fresh funded book plus up to eight overlapping transactions. */
const RUNS = 15;

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 20 });
});

afterAll(async () => {
  await pool.end();
});

describe.each(STRATEGIES)('a generated concurrent batch under %s', (strategy) => {
  it('conserves value and never overdraws, whichever transfers win', async () => {
    const { service } = createService(pool, { strategy });

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1_000n, max: 30_000n }), { minLength: 2, maxLength: 8 }),
        async (amounts) => {
          const book = await fundedBook(pool, service, OPENING);

          // Every transfer drains the one guarded account, which is what makes the batch
          // collectively unaffordable while each is individually fine - the shape stage 4's
          // race needs, generated rather than fixed.
          const transfers: TransferSpec[] = amounts.map((amountMinor) => ({
            fromAccountId: book.cash,
            toAccountId: book.rent,
            amountMinor,
          }));

          const outcome = await fireTransfers(service, book, transfers);

          for (const error of outcome.errors) {
            const acceptable =
              error instanceof AccountOverdrawnError ||
              (strategy === 'serializable' &&
                hasSqlState(error, SQLSTATE.SERIALIZATION_FAILURE));

            expect(acceptable, `unexpected rejection: ${String(error)}`).toBe(true);
          }

          const cash = await balanceOf(pool, book.bookId, book.cash);
          const rent = await balanceOf(pool, book.bookId, book.rent);
          const sales = await balanceOf(pool, book.bookId, book.sales);

          // Value conserved: the book still sums to zero.
          expect(cash + rent + sales, 'the book stopped summing to zero').toBe(0n);

          // The rule held. The final balance is also the *minimum prefix* here, which is the
          // form the rule actually takes: every transfer is negative on `cash` and they all
          // share one `occurred_at`, so the running total only ever falls and its lowest point
          // is where it ends. A batch with positive legs would need the prefix query instead.
          expect(cash, 'the guarded account went negative').toBeGreaterThanOrEqual(0n);

          // Every fulfilled call committed an entry, and every rejected one committed none.
          // Without this, a run in which every transfer failed would satisfy both assertions
          // above - which is the shape every failure mode here actually takes.
          const rows = await queryInBook<{ count: string }>(
            pool,
            book.bookId,
            "SELECT count(*)::text AS count FROM entries WHERE description LIKE 'concurrent transfer%'",
          );

          expect(Number(rows[0]?.count ?? '0'), 'committed entries against fulfilled calls').toBe(
            outcome.accepted,
          );
        },
      ),
      // The corpus replays before anything is generated. It is also the only reproducibility
      // this property has: the batch shape is generated, but which transfer wins is a race, so
      // a failing shape is worth pinning even though replaying it may not fail again.
      { numRuns: RUNS, examples: CONCURRENT_BATCH_EXAMPLES },
    );
  });
});
