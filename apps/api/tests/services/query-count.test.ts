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

    // Compares the statements themselves, not just how many there were: the same count with one
    // query swapped for a different one of equal count would pass a length check and should not
    // pass this one.
    expect(
      large.statements,
      `page of 50 sent:\n${large.statements.join('\n')}\n\npage of 1 sent:\n${small.statements.join('\n')}`,
    ).toEqual(small.statements);
  });

  it('sends a fixed number of statements on the first page', async () => {
    const page = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 10 }),
    );

    // begin, set_config, find the account, read the page, commit. No opening-balance sum,
    // because the first page opens at zero.
    expect(page.statements, page.statements.join('\n')).toHaveLength(5);
  });

  it('sends two more statements on a later page, for the checkpoint lookup and the opening balance', async () => {
    const first = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 10 }),
    );
    const cursor = first.result.nextCursor;
    expect(cursor).not.toBeNull();

    const second = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { cursor: cursor ?? undefined, limit: 10 }),
    );

    // Two more than the first page, not one: `latestCheckpoint` looks for a watermark to
    // resume from, finds none for this account, and `balanceThrough` falls back to
    // `sumPostingsThrough` - the same fresh sum-from-zero this used to run unconditionally.
    // The count is still constant per page rather than growing with it, which is the
    // property this file exists to defend; a checkpoint lookup replacing the plain sum here
    // would have kept it at one extra, but there is none for this account to find.
    expect(second.statements, second.statements.join('\n')).toHaveLength(7);
  });
});

describe('getBalance', () => {
  /** A fresh two-leg entry, cash in and sales out - the fixture other files in this tree use. */
  async function seedEntry(target: Book, amountMinor: bigint, occurredAt: string): Promise<void> {
    await service.postEntry(target.bookId, {
      occurredAt,
      description: 'seed',
      legs: [
        { accountId: target.cash, amount: formatMoney(money(amountMinor, 'EUR')), currency: 'EUR' },
        { accountId: target.sales, amount: formatMoney(money(-amountMinor, 'EUR')), currency: 'EUR' },
      ],
    });
  }

  it('sends a fixed number of statements when there is no checkpoint to resume from', async () => {
    const target = await seedBookIn(pool);
    await seedEntry(target, 100n, '2026-01-01T00:00:00.000Z');

    const page = await recorder.measure(() => service.getBalance(target.bookId, target.cash));

    // begin, set_config, find the account, `latestCheckpoint` (finds nothing), `sumPostings`,
    // commit. The checkpoint lookup runs and is counted here even though it finds no row - a
    // future revert of `getBalance` back to a bare `sumPostings` call would drop this to 5
    // rather than pass silently, since checkpoint-or-not the numeric answer is the same either
    // way.
    expect(page.statements, page.statements.join('\n')).toHaveLength(6);
  });

  it('sends the same fixed number of statements when a checkpoint exists', async () => {
    const target = await seedBookIn(pool);
    await seedEntry(target, 100n, '2026-01-01T00:00:00.000Z');
    await service.checkpointAccount(target.bookId, target.cash);
    await seedEntry(target, 50n, '2026-01-02T00:00:00.000Z');

    const page = await recorder.measure(() => service.getBalance(target.bookId, target.cash));

    // Same six statements, not seven: `latestCheckpoint` now finds a row, and the
    // sum-from-zero (`sumPostings`) is replaced by `sumPostingsAfter` from the watermark
    // rather than added to it.
    expect(page.statements, page.statements.join('\n')).toHaveLength(6);
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
    // Compares the statements themselves, not just how many there were - see the comment on the
    // equivalent assertion in the `listPostings` block above.
    expect(large.statements, `wide book sent:\n${large.statements.join('\n')}`).toEqual(
      small.statements,
    );
  });
});
