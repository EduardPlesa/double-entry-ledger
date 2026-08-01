import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LedgerService, PostEntryInput } from '../../src/services/ledger.service.js';
import { balanceOf, seedBookIn, type Book } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * Two entries, two guarded accounts, opposite leg order.
 *
 * This is the failure the `ORDER BY id` in `lockAccounts` exists to prevent. Without it the
 * lock order follows the order the legs happened to arrive in, so one transaction holds cash
 * and wants bank while the other holds bank and wants cash, and Postgres breaks the tie by
 * killing one of them with a 40P01. With it, both take cash first and one simply waits.
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
