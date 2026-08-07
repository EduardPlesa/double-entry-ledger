import { newId } from '@ledger/shared';
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
 * Two entries, several shared accounts, opposite leg order - posted through the service, end
 * to end.
 *
 * Without something forcing a consistent lock order, one transaction would hold cash and want
 * bank while the other holds bank and wants cash, and Postgres breaks the tie by killing one
 * of them with a 40P01. There are two things in this codebase that could be that something:
 * `accountsTouched` sorts the ids in JavaScript before `postEntry` ever calls `lockAccounts`,
 * and `lockAccounts` itself emits `ORDER BY id` in its SQL. This test goes through the service,
 * so every call it makes is already sorted by the time it reaches `lockAccounts` - it is the
 * JS sort this test exercises, not the SQL clause. A direct test below calls
 * `repository.lockAccounts` itself, bypassing the JS sort, to reach the code path this one
 * cannot.
 *
 * `accountsTouched` is the whole reason this file's coverage needed a second look after the
 * checkpoint fix: it locks every account an entry posts to, not only the guarded ones losing
 * money, so `drain` below - which always had a third, unguarded, positive leg on `rent` - now
 * locks three accounts per call instead of two. This test's own sort discipline was never
 * exercised past a pair before; it is now, on every run, without needing a dedicated fixture
 * for it.
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

describe('two entries locking the same three accounts', () => {
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
 * The case that was actually broken when this test was written, and a case whose own mechanism
 * has since moved - the history is worth keeping honest rather than pretending the scenario
 * below still exercises what it first caught.
 *
 * `transfer(from, to)` is two legs: `from -1`, `to +1`. At the time this test was added, only
 * the negative leg's account was locked - `[cash -1, bank +1]` put `cash` in the lock set and
 * left `bank` out of it, but the transaction still *wrote* a posting to `bank`, and inserting
 * that posting made Postgres check `postings_account_same_book_currency_fk` against the parent
 * row as `SELECT 1 FROM accounts WHERE id = bank ... FOR KEY SHARE`. That was a lock this code
 * never asked for, never sorted, and never knew it was taking. Under `FOR UPDATE` - which
 * conflicts with `FOR KEY SHARE` - the mirrored entry `[bank -1, cash +1]` held `bank`
 * explicitly and waited on `cash` implicitly, this one held `cash` and waited on `bank`, and
 * Postgres broke the tie with a 40P01. `withRetry` deliberately does not retry a deadlock and
 * nothing translates it, so the loser of a perfectly legitimate transfer received a raw driver
 * error and an HTTP 500. `FOR NO KEY UPDATE` was what fixed it: it still conflicts with itself,
 * so two concurrent withdrawals from one account serialise exactly as before, but it does not
 * conflict with the `FOR KEY SHARE` a foreign key check takes, so the FK check and the
 * concurrent deposit passed straight through.
 *
 * `accountsTouched` widened the lock set to every account a leg names, guarded or not,
 * negative or not - see `ledger.service.ts`'s comment on `lockTouchedAccounts` for why. Under
 * that set, `[cash -1, bank +1]` locks *both* `cash` and `bank` explicitly, and so does the
 * mirrored `[bank -1, cash +1]` - both sides now lock the identical pair, sorted, before either
 * ever reaches an insert. Neither side is relying on the other's implicit `FOR KEY SHARE`
 * anymore, so this specific scenario is, structurally, the same "two entries, one shared set,
 * sorted the same way" case the very first test in this file covers - not the asymmetric one
 * this comment used to describe.
 *
 * `FOR NO KEY UPDATE` is still the mode, and this test - unchanged, still passing - is still
 * useful evidence that widening the lock set did not quietly reintroduce the deadlock it was
 * chosen to fix. What it no longer does is exercise the *reason* the mode still matters: that
 * moved to `checkpointAccount`, which takes only one account's lock, on its own, and still
 * must not conflict with a concurrent `FOR KEY SHARE` from an unrelated FK check - see the
 * `checkpointAccount` describe block below, which is this test's replacement for that specific
 * purpose.
 *
 * Several rounds rather than one, kept from the original test: cheap insurance against a
 * regression that only shows up under a particular interleaving, even though the specific
 * interleaving this was written to force no longer applies.
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
   * because `accountsTouched` always hands it an already-sorted list - the ids it
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

    // 40P01 is deadlock_detected. Nothing here should produce one. Through `sqlStatesOf`,
    // same as the other two assertions in this file - reading `.code` off the rejection
    // directly yields `undefined` for a drizzle-wrapped error and would pass this exact
    // check while a deadlock was happening.
    expect(sqlStatesOf(settled)).not.toContain('40P01');
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);
  });
});

/**
 * `checkpointAccount` locking the account it reads is the change this file exists to guard
 * now, and it carries a different shape of risk than the write-path widening above: it takes
 * exactly one lock, on its own, never asks for a second one, and therefore cannot itself be a
 * participant in a wait cycle - a transaction can only deadlock by holding something another
 * transaction is waiting for, and this one never holds anything past the single row it locks
 * up front. That is a property of the code, not something a test can additionally prove by
 * running it enough times; what these two tests cover instead is the two concrete interactions
 * that widening created, both of which were absent before this change existed to check.
 */
describe('checkpointAccount locking the account it reads', () => {
  const ROUNDS = 3;

  /**
   * `checkpointAccount(cash)` against a `postEntry` that also touches `cash`, fired together.
   *
   * Before this change, `checkpointAccount` took no lock at all, so there was nothing here to
   * test - a checkpoint and a write to the same account never contended for anything. Now both
   * take `FOR NO KEY UPDATE` on `cash`, and the only two acceptable outcomes are: the write
   * gets there first and the checkpoint waits, or the checkpoint gets there first and the write
   * waits. Either is a block, never a 40P01, because `checkpointAccount` cannot be one side of
   * a cycle. The `transfer` entry also touches `bank`, so this exercises the write path holding
   * two locks (sorted) while the checkpoint holds one on the account they share.
   */
  it('does not deadlock against a concurrent write to the same account', async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const book = await seedBookIn(pool);
      await fundBothAccounts(book);

      const settled = await Promise.allSettled([
        service.postEntry(book.bookId, transfer(book.cash, book.bank)),
        service.checkpointAccount(book.bookId, book.cash),
      ]);

      const codes = sqlStatesOf(settled);
      expect(codes, `round ${round.toString()} deadlocked`).not.toContain('40P01');
      expect(
        settled.every((result) => result.status === 'fulfilled'),
        `round ${round.toString()} rejected: ${JSON.stringify(codes)}`,
      ).toBe(true);
    }
  });

  /**
   * `checkpointAccount(cash)` against `createAccount` inserting a *new* account whose
   * `parent_id` is `cash`, fired together.
   *
   * This is the scenario `FOR NO KEY UPDATE` is for now, in the sense that matters for new
   * code rather than history: `checkpointAccount` explicitly locks `cash` with it, and
   * `createAccount`'s insert implicitly takes `FOR KEY SHARE` on the same row for
   * `accounts_parent_same_book_fk`'s check - a lock `createAccount` never asks for by name and
   * this test never orders, the same shape the old crossed-transfer scenario was before the
   * write path widened. `FOR UPDATE` would conflict with that `FOR KEY SHARE` and could
   * deadlock a maintenance read against an unrelated account-tree write; `FOR NO KEY UPDATE`
   * does not conflict with it, so both proceed.
   */
  it('does not deadlock against a concurrent child-account insert under the same parent', async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const book = await seedBookIn(pool);
      await fundBothAccounts(book);

      const settled = await Promise.allSettled([
        service.checkpointAccount(book.bookId, book.cash),
        service.createAccount(book.bookId, {
          name: `child of cash, round ${round.toString()}`,
          type: 'asset',
          currency: 'EUR',
          parentId: book.cash,
        }),
      ]);

      const codes = sqlStatesOf(settled);
      expect(codes, `round ${round.toString()} deadlocked`).not.toContain('40P01');
      expect(
        settled.every((result) => result.status === 'fulfilled'),
        `round ${round.toString()} rejected: ${JSON.stringify(codes)}`,
      ).toBe(true);
    }
  });
});

/**
 * `sqlStatesOf` is what makes the deadlock assertions above mean anything - a helper that
 * silently returned `[]` for every rejection would let `not.toContain('40P01')` pass whether
 * or not a deadlock occurred. This checks it against a real rejection from this same driver
 * stack, not against a hand-built error shape, so a change to how drizzle wraps node-postgres
 * errors would be caught here rather than by every deadlock test going blind at once.
 */
describe('sqlStatesOf', () => {
  it('recovers a real SQLSTATE from a drizzle-wrapped driver error', async () => {
    const client = await pool.connect();

    try {
      const db = drizzle(client, { schema });
      const id = newId();
      const duplicate = { id, name: 'sqlStatesOf fixture', baseCurrency: 'EUR' };

      // A duplicate primary key, inserted twice through a drizzle handle rather than a raw
      // `pg` client, so the rejection is genuinely wrapped the way `hasSqlState`'s own
      // comment describes - drizzle's own error, with node-postgres' `23505` as its `cause`
      // - and not a shape this test constructed by hand.
      await db.insert(schema.books).values(duplicate);
      const settled = await Promise.allSettled([db.insert(schema.books).values(duplicate)]);

      expect(settled[0]?.status).toBe('rejected');
      expect(sqlStatesOf(settled)).toContain(SQLSTATE.UNIQUE_VIOLATION);
    } finally {
      client.release();
    }
  });
});
