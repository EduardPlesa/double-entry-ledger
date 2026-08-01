import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
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

describe('two entries locking the same pair of accounts', () => {
  it('does not deadlock when the legs arrive in opposite orders', async () => {
    const book = await seedBookIn(pool);

    // Fund both guarded accounts so the overdraft rule is not what rejects anything.
    await service.postEntry(book.bookId, {
      occurredAt: '2026-01-01T00:00:00.000Z',
      description: 'opening balances',
      legs: [
        { accountId: book.cash, amount: '100.00', currency: 'EUR' },
        { accountId: book.bank, amount: '100.00', currency: 'EUR' },
        { accountId: book.sales, amount: '-200.00', currency: 'EUR' },
      ],
    });

    const settled = await Promise.allSettled([
      service.postEntry(book.bookId, drain(book, book.cash, book.bank)),
      service.postEntry(book.bookId, drain(book, book.bank, book.cash)),
    ]);

    const codes = settled.flatMap((result) =>
      result.status === 'rejected' ? [(result.reason as { code?: string }).code] : [],
    );

    // 40P01 is deadlock_detected. Nothing here should produce one.
    expect(codes).not.toContain('40P01');
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);

    expect(await balanceOf(pool, book.bookId, book.cash)).toBe(9800n);
    expect(await balanceOf(pool, book.bookId, book.bank)).toBe(9800n);
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
