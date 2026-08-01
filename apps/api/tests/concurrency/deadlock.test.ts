import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { SQLSTATE, hasSqlState } from '../../src/db/pg-errors.js';
import * as schema from '../../src/db/schema.js';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import type { LedgerService, PostEntryInput } from '../../src/services/ledger.service.js';
import { balanceOf, seedBookIn, setBookContext, type Book } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * Two entries, two guarded accounts, opposite leg order - posted through the service, end to
 * end.
 *
 * Without something forcing a consistent lock order, one transaction would hold cash and want
 * bank while the other holds bank and wants cash, and Postgres breaks the tie by killing one
 * of them with a 40P01. There are two things in this codebase that could be that something:
 * `guardedAccountsAtRisk` sorts the ids in JavaScript before `postEntry` ever calls
 * `lockAccounts`, and `lockAccounts` itself emits `ORDER BY id` in its SQL. This test goes
 * through the service, so every call it makes is already sorted by the time it reaches
 * `lockAccounts` - it is the JS sort this test exercises, not the SQL clause. A direct test
 * below calls `repository.lockAccounts` itself, bypassing the JS sort, to reach the code path
 * this one cannot.
 *
 * A deadlock here would surface as a rejection carrying SQLSTATE 40P01, which is why the
 * assertion is about the error codes and not only about the balances.
 */

let pool: Pool;
let service: LedgerService;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 10 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

/** Takes money out of both guarded accounts at once, in the given order. */
function drain(book: Book, first: string, second: string): PostEntryInput {
  return {
    occurredAt: '2026-02-01T00:00:00.000Z',
    description: 'draining two accounts',
    legs: [
      { accountId: first, amount: '-1.00', currency: 'EUR' },
      { accountId: second, amount: '-1.00', currency: 'EUR' },
      { accountId: book.rent, amount: '2.00', currency: 'EUR' },
    ],
  };
}

/** Moves a euro from one guarded account to the other. One negative leg, one positive. */
function transfer(from: string, to: string): PostEntryInput {
  return {
    occurredAt: '2026-02-01T00:00:00.000Z',
    description: 'moving a euro between two accounts',
    legs: [
      { accountId: from, amount: '-1.00', currency: 'EUR' },
      { accountId: to, amount: '1.00', currency: 'EUR' },
    ],
  };
}

/** Funds both guarded accounts so the overdraft rule is not what rejects anything. */
async function fundBothAccounts(book: Book): Promise<void> {
  await service.postEntry(book.bookId, {
    occurredAt: '2026-01-01T00:00:00.000Z',
    description: 'opening balances',
    legs: [
      { accountId: book.cash, amount: '100.00', currency: 'EUR' },
      { accountId: book.bank, amount: '100.00', currency: 'EUR' },
      { accountId: book.sales, amount: '-200.00', currency: 'EUR' },
    ],
  });
}

/**
 * The SQLSTATEs of whatever was rejected. `40P01` is deadlock_detected.
 *
 * Through `hasSqlState` rather than by reading `.code` off the rejection, because drizzle does
 * not rethrow node-postgres' error - it throws its own with the original as `cause`. Reading
 * the top-level `.code` yields `undefined` for every driver error there is, so an assertion
 * built on it reports `[undefined]` for a genuine deadlock and would pass a
 * `not.toContain('40P01')` check while the deadlock was happening.
 */
function sqlStatesOf(settled: readonly PromiseSettledResult<unknown>[]): string[] {
  return settled.flatMap((result) => {
    if (result.status !== 'rejected') return [];

    const known = Object.values(SQLSTATE).find((state) => hasSqlState(result.reason, state));
    return [known ?? describeReason(result.reason)];
  });
}

/** Whatever an unrecognised rejection can say for itself, so a failure message is readable. */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

describe('two entries locking the same pair of accounts', () => {
  it('does not deadlock when the legs arrive in opposite orders', async () => {
    const book = await seedBookIn(pool);
    await fundBothAccounts(book);

    const settled = await Promise.allSettled([
      service.postEntry(book.bookId, drain(book, book.cash, book.bank)),
      service.postEntry(book.bookId, drain(book, book.bank, book.cash)),
    ]);

    // 40P01 is deadlock_detected. Nothing here should produce one.
    expect(sqlStatesOf(settled)).not.toContain('40P01');
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);

    expect(await balanceOf(pool, book.bookId, book.cash)).toBe(9800n);
    expect(await balanceOf(pool, book.bookId, book.bank)).toBe(9800n);
  });
});

/**
 * The case the test above structurally cannot reach, and the one that was actually broken.
 *
 * Both entries there drain *both* accounts, so both accounts land in both at-risk sets and
 * both transactions lock the pair in the same sorted order. Every account either side touches
 * is an account it holds an explicit lock on, so the only ordering that could go wrong is one
 * `guardedAccountsAtRisk` has already fixed.
 *
 * A crossed transfer is different, and the difference is the whole finding. `[cash -1, bank
 * +1]` puts only `cash` in the at-risk set, so `lockAccountsAtRisk` locks `cash` and nothing
 * else - but the transaction still *writes* a posting to `bank`, and inserting that posting
 * makes Postgres check `postings_account_same_book_currency_fk` against the parent row as
 * `SELECT 1 FROM accounts WHERE id = bank ... FOR KEY SHARE`. That is a lock this code never
 * asked for, never sorted, and never knew it was taking. Under `FOR UPDATE` - which conflicts
 * with `FOR KEY SHARE` - the mirrored entry `[bank -1, cash +1]` holds `bank` and waits for
 * `cash`, this one holds `cash` and waits for `bank`, and Postgres breaks the tie with a
 * 40P01. `withRetry` deliberately does not retry a deadlock and nothing translates it, so the
 * loser of a perfectly legitimate transfer received a raw driver error and an HTTP 500.
 *
 * `FOR NO KEY UPDATE` is what makes this pass. It still conflicts with itself, so two
 * concurrent withdrawals from one account serialise exactly as before - which is the entire
 * purpose of the lock and what `overdraft.race.test.ts` measures - but it does not conflict
 * with the `FOR KEY SHARE` a foreign key check takes, so the FK checks and the concurrent
 * deposits pass straight through.
 *
 * Several rounds rather than one. The deadlock needs both sides to have taken their explicit
 * lock before either reaches the other's foreign key check, and while that overlap is easy to
 * hit it is not guaranteed on any single pair. Against `.for('update')` this reproduced a
 * genuine 40P01 within the first two rounds; the loop is what makes it evidence rather than
 * an anecdote.
 */
describe('two crossed transfers between the same pair of accounts', () => {
  it('does not deadlock when one entry is the mirror of the other', async () => {
    const ROUNDS = 5;

    for (let round = 1; round <= ROUNDS; round += 1) {
      const book = await seedBookIn(pool);
      await fundBothAccounts(book);

      const settled = await Promise.allSettled([
        service.postEntry(book.bookId, transfer(book.cash, book.bank)),
        service.postEntry(book.bookId, transfer(book.bank, book.cash)),
      ]);

      const codes = sqlStatesOf(settled);

      expect(codes, `round ${round.toString()} deadlocked`).not.toContain('40P01');
      expect(
        settled.every((result) => result.status === 'fulfilled'),
        `round ${round.toString()} rejected a legitimate transfer: ${JSON.stringify(codes)}`,
      ).toBe(true);

      // The two transfers cancel: each account gave a euro and received one.
      expect(await balanceOf(pool, book.bookId, book.cash)).toBe(10_000n);
      expect(await balanceOf(pool, book.bookId, book.bank)).toBe(10_000n);
    }
  });
});

describe('lockAccounts called directly, bypassing the JS sort', () => {
  /**
   * The test above can never see what `lockAccounts`'s own `ORDER BY id` does by itself,
   * because `guardedAccountsAtRisk` always hands it an already-sorted list - the ids it
   * receives there are never out of order to begin with. This test closes that gap: it calls
   * `repository.lockAccounts` directly, from two separate connections, each handed the same
   * two account ids in the opposite order from the other.
   *
   * Both calls have to be genuinely in flight together, not just both eventually run, for
   * this to test anything. A raw `pg.PoolClient` per side, each wrapped in its own
   * `drizzle()` handle and fired via `Promise.all` rather than sequential `await`s, is what
   * gives both statements a real chance to be acquiring rows at the same moment - if one
   * connection's statement ran to completion before the other's was even sent, there would be
   * nothing for either to wait on. Inside each statement Postgres locks the rows it finds one
   * at a time, taking the first before it ever attempts the second; a genuine wait, and with
   * it a genuine chance to deadlock, only shows up when the two statements' executions
   * overlap enough for the second attempt on one side to land while the first side's lock is
   * still held.
   *
   * This does not currently discriminate the `ORDER BY id` clause it exists to guard, and
   * that is worth saying plainly rather than leaving the test to imply otherwise. `accounts`
   * has two btree indexes that lead with `id`, and Postgres's own handling of an indexed
   * `IN (...)` already visits the matching rows in ascending `id` order regardless of the
   * order the list was written in - confirmed with `EXPLAIN`, whose plan is identical with
   * the clause present, absent, or reversed to `DESC`, and confirmed by removing
   * `.orderBy(asc(accounts.id))` from `lockAccounts` locally and re-running this exact test
   * against a real two-connection race: still no 40P01, repeatedly, including with the
   * planner's index scan disabled so the query falls back to a sequential scan. What this
   * test does verify, and nothing before it did, is that calling `lockAccounts` with unsorted
   * input is safe in practice today - real coverage of a path nothing else in this suite
   * reaches, and one that would catch a regression in anything else this method depends on,
   * such as a change to its predicate or a reshaped index. It is not proof that the
   * `ORDER BY id` clause itself is load-bearing against the schema as it stands.
   */
  it('does not deadlock when lockAccounts is called with the same two ids in reversed order on two connections', async () => {
    const book = await seedBookIn(pool);
    const repository = new DrizzleLedgerRepository();

    const lockBothReversed = async (first: string, second: string): Promise<void> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await setBookContext(client, book.bookId);
        await repository.lockAccounts(drizzle(client, { schema }), [first, second]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    const settled = await Promise.allSettled([
      lockBothReversed(book.cash, book.bank),
      lockBothReversed(book.bank, book.cash),
    ]);

    const codes = settled.flatMap((result) =>
      result.status === 'rejected' ? [(result.reason as { code?: string }).code] : [],
    );

    // 40P01 is deadlock_detected. Nothing here should produce one.
    expect(codes).not.toContain('40P01');
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
  });
});
