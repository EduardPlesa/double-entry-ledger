import { formatMoney, money, newId } from '@ledger/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { CheckpointRequiresRowLockError, type LedgerService } from '../../src/services/ledger.service.js';
import { seedBookIn, type Book } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * The checkpoint, through the service.
 *
 * Every case here asserts the same thing twice over: that the fast path returns what the
 * sum from zero returns. The property test generalises it; these pin the two shapes that
 * motivated the design - an entry that lands *behind* a checkpoint, and a reversal recorded
 * after one.
 */

let pool: Pool;
let service: LedgerService;
let book: Book;

beforeAll(async () => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 5 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

// A fresh book per test. Checkpoints and balances are cumulative on an account, so reusing one
// book across cases would make each assertion about balances an earlier case left behind rather
// than about its own postings.
beforeEach(async () => {
  book = await seedBookIn(pool);
});

/** Cash in, sales out - the same two-leg shape `ledger.service.test.ts` posts, parameterised. */
async function post(overrides: { amountMinor: bigint; occurredAt: string }) {
  const { entry } = await service.postEntry(book.bookId, {
    occurredAt: overrides.occurredAt,
    description: 'a sale',
    legs: [
      { accountId: book.cash, amount: formatMoney(money(overrides.amountMinor, 'EUR')), currency: 'EUR' },
      { accountId: book.sales, amount: formatMoney(money(-overrides.amountMinor, 'EUR')), currency: 'EUR' },
    ],
  });
  return entry;
}

describe('checkpointAccount', () => {
  it('writes nothing for an account with no postings', async () => {
    const result = await service.checkpointAccount(book.bookId, book.rent);

    expect(result.written).toBe(false);
    expect(result.throughId).toBe(0n);
  });

  it('is a no-op when run twice with nothing in between', async () => {
    await post({ amountMinor: 5000n, occurredAt: '2026-02-01T00:00:00.000Z' });

    const first = await service.checkpointAccount(book.bookId, book.cash);
    const second = await service.checkpointAccount(book.bookId, book.cash);

    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(second.throughId).toBe(first.throughId);
  });

  it('serves the same balance through a checkpoint as from zero', async () => {
    await post({ amountMinor: 5000n, occurredAt: '2026-02-01T00:00:00.000Z' });
    await service.checkpointAccount(book.bookId, book.cash);
    await post({ amountMinor: 2500n, occurredAt: '2026-02-02T00:00:00.000Z' });

    const balance = await service.getBalance(book.bookId, book.cash);

    expect(balance.balance.amountMinor).toBe(7500n);
  });

  it('is unmoved by an entry backdated behind the checkpoint', async () => {
    await post({ amountMinor: 5000n, occurredAt: '2026-02-10T00:00:00.000Z' });
    await service.checkpointAccount(book.bookId, book.cash);

    // Recorded now, occurred before everything the checkpoint summed. Its posting id is
    // still above the watermark, which is the entire argument for keying on id.
    await post({ amountMinor: 1000n, occurredAt: '2026-01-01T00:00:00.000Z' });

    const balance = await service.getBalance(book.bookId, book.cash);

    expect(balance.balance.amountMinor).toBe(6000n);
  });

  it('is unmoved by a reversal recorded after the checkpoint', async () => {
    const entry = await post({ amountMinor: 5000n, occurredAt: '2026-02-10T00:00:00.000Z' });
    await service.checkpointAccount(book.bookId, book.cash);
    await service.reverseEntry(book.bookId, entry.id, {});

    const balance = await service.getBalance(book.bookId, book.cash);

    expect(balance.balance.amountMinor).toBe(0n);
  });

  it('ignores the checkpoint for an asOf read', async () => {
    await post({ amountMinor: 5000n, occurredAt: '2026-02-01T00:00:00.000Z' });
    await service.checkpointAccount(book.bookId, book.cash);
    await post({ amountMinor: 1000n, occurredAt: '2026-01-01T00:00:00.000Z' });

    const asOf = await service.getBalance(book.bookId, book.cash, new Date('2026-01-15T00:00:00.000Z'));

    // The backdated entry counts and the checkpointed one does not: an occurred_at question,
    // answered from zero, because an id-keyed checkpoint cannot answer it.
    expect(asOf.balance.amountMinor).toBe(1000n);
  });

  it('opens a page from the sum-from-zero fallback when the cursor sits behind the checkpoint', async () => {
    for (let i = 0; i < 5; i += 1) {
      await post({ amountMinor: 1000n, occurredAt: `2026-02-0${(i + 1).toString()}T00:00:00.000Z` });
    }
    await service.checkpointAccount(book.bookId, book.cash);

    const first = await service.listPostings(book.bookId, book.cash, { limit: 2 });
    const second = await service.listPostings(book.bookId, book.cash, {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });

    // The checkpoint's watermark is the fifth posting; this page's cursor is the second, so
    // `balanceThrough` takes the fallback - `checkpoint.throughId > afterId` - and the opening
    // balance is a fresh sum-from-zero, not `checkpoint.balanceMinor + delta`. The third and
    // fourth postings, so the running balance opens at 2000 and closes at 4000.
    expect(second.items[0]?.runningBalance.amountMinor).toBe(3000n);
    expect(second.items[1]?.runningBalance.amountMinor).toBe(4000n);
  });

  it('opens a page from the checkpoint delta when the cursor sits ahead of it', async () => {
    for (let i = 0; i < 3; i += 1) {
      await post({ amountMinor: 1000n, occurredAt: `2026-02-0${(i + 1).toString()}T00:00:00.000Z` });
    }
    const checkpoint = await service.checkpointAccount(book.bookId, book.cash);
    expect(checkpoint.written).toBe(true);

    for (let i = 3; i < 7; i += 1) {
      await post({ amountMinor: 1000n, occurredAt: `2026-02-0${(i + 1).toString()}T00:00:00.000Z` });
    }

    const first = await service.listPostings(book.bookId, book.cash, { limit: 5 });
    const second = await service.listPostings(book.bookId, book.cash, {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });

    // The checkpoint's watermark is the third posting; this page's cursor is the fifth, above
    // it, so `balanceThrough` takes `checkpoint.balanceMinor + sumPostingsAfter(...)` - the
    // branch the fallback-only version of this test never reached. The opening balance is the
    // checkpoint's 3000 plus the fourth and fifth postings (2000), and the sixth and seventh
    // postings then carry it to 6000 and 7000.
    expect(second.items[0]?.runningBalance.amountMinor).toBe(6000n);
    expect(second.items[1]?.runningBalance.amountMinor).toBe(7000n);
  });
});

/**
 * `checkpointAccount`'s refusal under `serializable`, and that `row-lock` is unaffected by it.
 *
 * Every other test in this file already exercises `row-lock` - it is what `createService(pool)`
 * defaults to - so this is where the *other* strategy, and the boundary between the two, gets
 * its own coverage rather than being left to a comment's word for it.
 */
describe('checkpointAccount and the serializable strategy', () => {
  it('refuses before any read, for a book and account that do not even exist', async () => {
    const serializable = createService(pool, { strategy: 'serializable' }).service;

    // Nonexistent ids on purpose: `AccountNotFoundError` would mean this got as far as a
    // lookup before refusing, which is exactly the ordering this test is here to rule out.
    await expect(serializable.checkpointAccount(newId(), newId())).rejects.toThrow(
      CheckpointRequiresRowLockError,
    );
  });

  it('refuses for a real, checkpointable account too, not only a missing one', async () => {
    const serializable = createService(pool, { strategy: 'serializable' }).service;

    await post({ amountMinor: 5000n, occurredAt: '2026-02-01T00:00:00.000Z' });

    await expect(serializable.checkpointAccount(book.bookId, book.cash)).rejects.toThrow(
      CheckpointRequiresRowLockError,
    );

    // Nothing was written: a checkpoint this method could not vouch for must not exist either.
    const checkpointed = await service.checkpointAccount(book.bookId, book.cash);
    expect(checkpointed.written).toBe(true);
    expect(checkpointed.throughId).toBeGreaterThan(0n);
  });

  it('is unaffected under row-lock - the strategy every other test in this file already uses', async () => {
    const rowLock = createService(pool, { strategy: 'row-lock' }).service;

    await post({ amountMinor: 1234n, occurredAt: '2026-02-01T00:00:00.000Z' });

    const result = await rowLock.checkpointAccount(book.bookId, book.cash);

    expect(result.written).toBe(true);
    expect(result.balance.amountMinor).toBe(1234n);
  });
});
