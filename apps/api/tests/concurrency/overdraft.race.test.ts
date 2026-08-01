import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { fireConcurrently, fundedBook } from '../helpers/concurrency.js';
import { balanceOf } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * The race the row locks close.
 *
 * `evidence/overdraft-race` has this same test against the naive implementation, where it
 * fails: sixteen individually affordable withdrawals all pass their check against a snapshot
 * taken before any of them committed, and the account ends up overdrawn by an amount no
 * single request ever asked for.
 *
 * What changed is not the rule but who decides. `SELECT ... FOR UPDATE` on the account row
 * makes the check and the insert one decision per account instead of two statements with a
 * window between them.
 */

const ROUNDS = 5;
/** €500.00 available, sixteen concurrent requests for €100.00. At most five may succeed. */
const OPENING = 50_000n;
const WITHDRAWAL = 10_000n;
const CONCURRENT = 16;

let pool: Pool;
let service: LedgerService;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 20 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

describe('concurrent withdrawals', () => {
  it('never drives a guarded account negative', async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const book = await fundedBook(pool, service, OPENING);

      await fireConcurrently(service, book, CONCURRENT, WITHDRAWAL);

      const balance = await balanceOf(pool, book.bookId, book.cash);

      expect(balance, `round ${round.toString()} left the account overdrawn`).toBeGreaterThanOrEqual(
        0n,
      );
    }
  });

  it('conserves total value regardless of who wins', async () => {
    const book = await fundedBook(pool, service, OPENING);

    await fireConcurrently(service, book, CONCURRENT, WITHDRAWAL);

    const cash = await balanceOf(pool, book.bookId, book.cash);
    const rent = await balanceOf(pool, book.bookId, book.rent);
    const sales = await balanceOf(pool, book.bookId, book.sales);

    expect(cash + rent + sales).toBe(0n);
  });
});
