import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, DrizzleUnitOfWork } from '../../src/db/client.js';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import { insertEntry, seedBook, withClient, type Book } from '../helpers/ledger.js';

/**
 * The window query, against a real Postgres. The interesting cases are all about ordering -
 * `occurred_at` is caller-asserted, so postings do not arrive in the order they happened -
 * and no fake could answer them.
 */

let pool: Pool;
let repository: DrizzleLedgerRepository;
let unitOfWork: DrizzleUnitOfWork;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 4 });
  repository = new DrizzleLedgerRepository();
  unitOfWork = new DrizzleUnitOfWork(createDatabase(pool));
});

afterAll(async () => {
  await pool.end();
});

/**
 * Seeds a book and commits the given entries, each at its own `occurred_at`.
 *
 * Backdated at INSERT time via `insertEntry`'s `occurredAt` option, not with a follow-up
 * UPDATE: entries are append-only (migration 0003), and `ledger_app` has no UPDATE privilege
 * on the table at all, so an UPDATE fails outright even on rows this same transaction just
 * inserted.
 */
async function bookWith(
  entries: readonly { occurredAt: string; amountMinor: bigint }[],
): Promise<Book> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    const book = await seedBook(client);

    for (const entry of entries) {
      await insertEntry(
        client,
        book,
        [
          { accountId: book.cash, amountMinor: entry.amountMinor },
          { accountId: book.sales, amountMinor: -entry.amountMinor },
        ],
        { occurredAt: entry.occurredAt },
      );
    }

    await client.query('COMMIT');
    return book;
  });
}

describe('lowestPrefixBalance', () => {
  it('is null for an account with no postings', async () => {
    const book = await bookWith([]);

    const lowest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, book.cash),
    );

    expect(lowest).toBeNull();
  });

  it('is the running minimum, not the final balance', async () => {
    // +500, then -800, then +1000: ends at +700, dips to -300 in the middle.
    const book = await bookWith([
      { occurredAt: '2026-01-01T00:00:00.000Z', amountMinor: 500n },
      { occurredAt: '2026-02-01T00:00:00.000Z', amountMinor: -800n },
      { occurredAt: '2026-03-01T00:00:00.000Z', amountMinor: 1000n },
    ]);

    const lowest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, book.cash),
    );

    expect(lowest?.balanceMinor).toBe(-300n);
    expect(lowest?.occurredAt.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('orders by occurred_at, not by insertion order', async () => {
    // The withdrawal is recorded second but happened first, so it dips below zero.
    const book = await bookWith([
      { occurredAt: '2026-02-01T00:00:00.000Z', amountMinor: 500n },
      { occurredAt: '2026-01-01T00:00:00.000Z', amountMinor: -200n },
    ]);

    const lowest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, book.cash),
    );

    expect(lowest?.balanceMinor).toBe(-200n);
    expect(lowest?.occurredAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('breaks ties on posting id, so the same instant has one answer', async () => {
    // Same instant: -200 then +500 dips, +500 then -200 does not. Insertion order decides.
    const book = await bookWith([
      { occurredAt: '2026-01-01T00:00:00.000Z', amountMinor: -200n },
      { occurredAt: '2026-01-01T00:00:00.000Z', amountMinor: 500n },
    ]);

    const lowest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, book.cash),
    );

    expect(lowest?.balanceMinor).toBe(-200n);
  });
});
