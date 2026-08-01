import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { fireConcurrently, fundedBook } from '../helpers/concurrency.js';
import { balanceOf } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * EVIDENCE. This test fails, and that is the point of the commit it lands in.
 *
 * The overdraft rule is implemented the obvious way: read the balance, check it, insert.
 * Every one of the withdrawals below is individually affordable, and the check passes for
 * every one of them - because under READ COMMITTED each transaction reads a snapshot taken
 * before any of the others committed. They then all insert, and the account ends up
 * overdrawn by an amount no single request ever asked for.
 *
 * The rule is not wrong. The isolation level is not strong enough to enforce it, and no
 * amount of care in the service can change that: a check and the write it authorises are two
 * statements, and nothing here makes them one decision.
 *
 * Reproduced across several rounds because a race is a probability, not a certainty. One
 * negative balance in any round is a failure - and one is all the claim needs.
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
