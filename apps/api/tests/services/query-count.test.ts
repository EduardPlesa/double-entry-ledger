import { formatMoney, money } from '@ledger/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { seedBookIn, type Book } from '../helpers/ledger.js';
import { instrumentPool, type QueryRecorder } from '../helpers/query-count.js';
import { createService } from '../helpers/service.js';

/**
 * The N+1 guard.
 *
 * A read path whose round trips grow with the size of its result is the regression this file
 * exists to fail on, and it is invisible to every other test in the suite: an N+1 returns
 * exactly the right answer, just once per row. So the assertion is not about correctness at
 * all - it is that the *same work* is done for one row as for fifty.
 *
 * Invariance is the guard; the exact count beside it catches creep, where each new round trip
 * looks reasonable on its own and nobody is counting.
 */

/** Enough postings on one account that a page of 50 and a page of 1 are genuinely different. */
const POSTINGS = 60;

let pool: Pool;
let recorder: QueryRecorder;
let service: LedgerService;
let book: Book;

beforeAll(async () => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 5 });
  // Before the first query, or the clients already in the pool go unpatched.
  recorder = instrumentPool(pool);
  service = createService(pool).service;

  book = await seedBookIn(pool);

  for (let index = 0; index < POSTINGS; index += 1) {
    await service.postEntry(book.bookId, {
      occurredAt: '2026-01-01T00:00:00.000Z',
      description: `seed ${index.toString()}`,
      legs: [
        { accountId: book.cash, amount: formatMoney(money(100n, 'EUR')), currency: 'EUR' },
        { accountId: book.sales, amount: formatMoney(money(-100n, 'EUR')), currency: 'EUR' },
      ],
    });
  }
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('listPostings', () => {
  it('sends the same statements for a page of 1 as for a page of 50', async () => {
    const small = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 1 }),
    );
    const large = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 50 }),
    );

    expect(small.result.items).toHaveLength(1);
    expect(large.result.items).toHaveLength(50);

    expect(
      large.statements.length,
      `page of 50 sent:\n${large.statements.join('\n')}\n\npage of 1 sent:\n${small.statements.join('\n')}`,
    ).toBe(small.statements.length);
  });

  it('sends a fixed number of statements on the first page', async () => {
    const page = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 10 }),
    );

    // begin, set_config, find the account, read the page, commit. No opening-balance sum,
    // because the first page opens at zero.
    expect(page.statements, page.statements.join('\n')).toHaveLength(5);
  });

  it('sends one more statement on a later page, for the opening balance', async () => {
    const first = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 10 }),
    );
    const cursor = first.result.nextCursor;
    expect(cursor).not.toBeNull();

    const second = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { cursor: cursor ?? undefined, limit: 10 }),
    );

    // The extra one is `sumPostingsThrough`: a fresh sum-from-zero up to the cursor, which is
    // the query stage 7 replaces with a checkpoint lookup. Pinned so that replacement is a
    // deliberate edit to this number rather than a silent change.
    expect(second.statements, second.statements.join('\n')).toHaveLength(6);
  });
});

describe('trialBalance', () => {
  it('sends the same statements however many accounts the book has', async () => {
    const small = await recorder.measure(() => service.trialBalance(book.bookId));

    const wide = await seedBookIn(pool);
    for (let index = 0; index < 14; index += 1) {
      await service.createAccount(wide.bookId, {
        name: `Extra ${index.toString()}`,
        type: 'expense',
        currency: 'EUR',
      });
    }

    const large = await recorder.measure(() => service.trialBalance(wide.bookId));

    expect(small.result.accounts.length).toBeLessThan(large.result.accounts.length);
    expect(
      large.statements.length,
      `wide book sent:\n${large.statements.join('\n')}`,
    ).toBe(small.statements.length);
  });
});
