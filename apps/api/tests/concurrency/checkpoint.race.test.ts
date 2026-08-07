import { newId } from '@ledger/shared';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as schema from '../../src/db/schema.js';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { balanceOf, seedBookIn, setBookContext } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * The race `computeCheckpoint`'s single-statement snapshot could not close on its own, and the
 * account lock that now closes it.
 *
 * `postings.id` is a bigserial: `nextval()` fires when the INSERT executes, not at COMMIT, and
 * it is not transactional. So a transaction that inserts first can still commit *after* another
 * transaction that inserted (and committed) later, and a single consistent read of `postings`
 * cannot, from the inside, tell "no writer is mid-insert for this account" apart from "one is,
 * and I simply cannot see its uncommitted row yet". Two designs that tried to make that read
 * alone sufficient - comparing each posting's `xmin` against a snapshot boundary, then draining
 * every transaction a snapshot's `xip_list` named before recomputing - were each disproved with
 * a reproducible counter-example; see `.superpowers/sdd/2026-08-06-stage-7-checkpoints/
 * final-review-fix-report.md`. What actually closes the race is `checkpointAccount` and the
 * write path both taking the account's `FOR NO KEY UPDATE` lock: with it held, nothing can be
 * mid-insert for the account, so the read really does describe a closed set.
 *
 * Two properties, two tests, both using a transaction held open on a raw connection so the
 * window is fully controlled rather than raced:
 *
 *   - `checkpointAccount` must actually wait for a concurrent holder of the account's lock,
 *     not merely happen to run after it. `waitForLockWaiter` polls `pg_stat_activity` for a
 *     genuine lock wait rather than trusting a fixed delay, so removing `checkpointAccount`'s
 *     own lock - and with it, its reason to wait at all - makes that poll time out and fails
 *     the test loudly, rather than leaving the race to reproduce only sometimes.
 *
 *   - The write path must lock an account even for a *positive* leg, which the pre-widening
 *     code never did. This is exercised through the real `service.postEntry`, not a
 *     hand-replicated lock call, specifically so a regression in `accountsTouched` - reverting
 *     it to the old guarded-and-negative-only filter - shows up here: `postEntry` would then
 *     never ask for the account's lock at all, the poll below would find nothing waiting, and
 *     the test would fail for that reason before the balance assertion ever ran.
 */

let pool: Pool;
let service: LedgerService;
const repository = new DrizzleLedgerRepository();

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 10 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

/**
 * Polls `pg_stat_activity` until some other backend is genuinely blocked on a lock, or gives
 * up.
 *
 * A fixed delay before proceeding would make this test pass by luck as often as by the fix
 * actually working: too short, and the awaited call might not have reached its lock request
 * yet even with the fix in place; too long, and a missing lock would still let the call finish
 * and the test would never observe that nothing was waiting. Polling for `wait_event_type =
 * 'Lock'` asks the one question that actually distinguishes "waiting for the lock this test
 * holds" from "already done" - `pid <> pg_backend_pid()` excludes this polling connection's own
 * row, and nothing else should be active in this book's isolated, single-file test run.
 */
async function waitForLockWaiter(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number }>(
      `select pid from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if (result.rows.length > 0) return true;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return false;
}

describe('checkpointAccount racing an uncommitted posting', () => {
  it('waits for a concurrent holder of the account lock instead of computing around it', async () => {
    const book = await seedBookIn(pool);

    // A committed baseline, so `cash` is not the "no postings yet" case computeCheckpoint
    // special-cases away.
    await service.postEntry(book.bookId, {
      occurredAt: '2026-01-01T00:00:00.000Z',
      description: 'opening balance',
      legs: [
        { accountId: book.cash, amount: '100.00', currency: 'EUR' },
        { accountId: book.sales, amount: '-100.00', currency: 'EUR' },
      ],
    });

    // Held open on its own connection: takes exactly the lock the fixed write path takes for a
    // leg on `cash`, inserts a posting, and does not commit until this test tells it to. Using
    // `repository.lockAccounts` directly rather than `service.postEntry` is deliberate here -
    // `service.postEntry` always commits or rolls back before returning, so there would be no
    // way to hold "inserted but not yet committed" open at all. This test's question is
    // specifically whether `checkpointAccount` respects a lock it finds already held, not which
    // legs decide to take one - the second test below covers that half.
    const held = await pool.connect();
    await held.query('BEGIN');
    await setBookContext(held, book.bookId);
    await repository.lockAccounts(drizzle(held, { schema }), [book.cash]);

    const entryId = newId();
    await held.query(
      `insert into entries (id, book_id, occurred_at, description) values ($1, $2, $3, $4)`,
      [entryId, book.bookId, '2026-02-01T00:00:00.000Z', 'held open, uncommitted'],
    );
    await held.query(
      `insert into postings (entry_id, book_id, account_id, amount_minor, currency)
       values ($1, $2, $3, 5000, 'EUR'), ($1, $2, $4, -5000, 'EUR')`,
      [entryId, book.bookId, book.cash, book.rent],
    );

    try {
      // Fired, not awaited yet: with the fix in place this cannot proceed past its own lock
      // request until `held` releases `cash`.
      const checkpointPromise = service.checkpointAccount(book.bookId, book.cash);

      const waited = await waitForLockWaiter(3000);
      expect(
        waited,
        'checkpointAccount never showed up waiting on a lock - either its own lock was removed, ' +
          'or it ran to completion before the held transaction ever mattered',
      ).toBe(true);

      // Only now does the held posting become permanent history.
      await held.query('COMMIT');

      await checkpointPromise;
    } catch (error) {
      await held.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      held.release();
    }

    const viaCheckpoint = await service.getBalance(book.bookId, book.cash);
    const fromZero = await balanceOf(pool, book.bookId, book.cash);

    // The two have to agree. If they do not, the checkpoint's watermark silently dropped the
    // held posting - permanently, since nothing about this account's future history can ever
    // bring `id > through_id` back to being true for that one row.
    expect(viaCheckpoint.balance.amountMinor, 'balance served through the checkpoint').toBe(
      fromZero,
    );
  });

  it('is blocked on, and blocks, a positive-leg posting through the real write path', async () => {
    const book = await seedBookIn(pool);

    // Held open, standing in for a concurrent checkpoint (or another writer) already holding
    // `cash`'s lock - the point of this test is the other side, so a direct `lockAccounts` call
    // is the right tool here, mirroring the previous test's own justification in reverse.
    const held = await pool.connect();
    await held.query('BEGIN');
    await setBookContext(held, book.bookId);
    await repository.lockAccounts(drizzle(held, { schema }), [book.cash]);

    try {
      // A deposit: every leg is positive. Before the write path widened, `lockAccountsAtRisk`
      // only ever locked a guarded account on a *negative* leg, so a deposit like this one
      // never asked for `cash`'s lock at all and would sail straight through `held`. Through
      // the real `service.postEntry`, not a hand-built statement, so a regression in
      // `accountsTouched` shows up here rather than only in a test that assumes the fix.
      const postEntryPromise = service.postEntry(book.bookId, {
        occurredAt: '2026-02-01T00:00:00.000Z',
        description: 'a deposit into the locked account',
        legs: [
          { accountId: book.cash, amount: '25.00', currency: 'EUR' },
          { accountId: book.sales, amount: '-25.00', currency: 'EUR' },
        ],
      });

      const waited = await waitForLockWaiter(3000);
      expect(
        waited,
        'postEntry never showed up waiting on cash\'s lock - a positive-only leg is not taking ' +
          'the account lock the write path is supposed to take for every leg now',
      ).toBe(true);

      await held.query('COMMIT');
      await postEntryPromise;
    } catch (error) {
      await held.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      held.release();
    }

    expect(await balanceOf(pool, book.bookId, book.cash)).toBe(2500n);
  });
});
