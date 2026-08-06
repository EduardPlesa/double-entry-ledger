import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { createDatabase, DrizzleUnitOfWork } from '../../src/db/client.js';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import { insertEntry, queryInBook, seedBook, withClient, type Book } from '../helpers/ledger.js';

/**
 * The checkpoint table's guarantees, at the level the database enforces them.
 *
 * A checkpoint is derived data - it can always be recomputed from the postings - so the
 * interesting assertions are not about its content but about who may change it. Append-only
 * for the runtime role, invisible across books, and impossible to attach to an account in
 * another book.
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

async function seed() {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    const book = await seedBook(client);
    await client.query('COMMIT');
    return book;
  });
}

/**
 * Seeds a book and commits the given entries, each at its own `occurred_at`.
 *
 * Copied from `tests/db/overdraft.prefix.test.ts` rather than shared: the two versions seed
 * different books, and they would diverge the moment either test file needed a third leg.
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

describe('balance_checkpoints', () => {
  it('accepts an insert and reads it back inside the book', async () => {
    const book = await seed();

    await queryInBook(
      pool,
      book.bookId,
      `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
       VALUES ($1, $2, $3, $4)`,
      [book.cash, book.bookId, '10', '5000'],
    );

    const rows = await queryInBook<{ balance_minor: string; through_id: string }>(
      pool,
      book.bookId,
      'SELECT through_id::text, balance_minor::text FROM balance_checkpoints WHERE account_id = $1',
      [book.cash],
    );

    expect(rows).toEqual([{ through_id: '10', balance_minor: '5000' }]);
  });

  it('refuses UPDATE and DELETE to the runtime role', async () => {
    const book = await seed();

    await queryInBook(
      pool,
      book.bookId,
      `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
       VALUES ($1, $2, 10, 5000)`,
      [book.cash, book.bookId],
    );

    // 42501 is insufficient_privilege: the REVOKE, not a policy and not a trigger.
    await expect(
      queryInBook(pool, book.bookId, 'UPDATE balance_checkpoints SET balance_minor = 0'),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      queryInBook(pool, book.bookId, 'DELETE FROM balance_checkpoints'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('hides another book\'s checkpoints', async () => {
    const mine = await seed();
    const theirs = await seed();

    await queryInBook(
      pool,
      theirs.bookId,
      `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
       VALUES ($1, $2, 10, 5000)`,
      [theirs.cash, theirs.bookId],
    );

    const rows = await queryInBook(pool, mine.bookId, 'SELECT * FROM balance_checkpoints');

    expect(rows).toHaveLength(0);
  });

  it('refuses a checkpoint whose book disagrees with its account', async () => {
    const mine = await seed();
    const theirs = await seed();

    // 23503 is foreign_key_violation: the composite key to (accounts.id, accounts.book_id).
    await expect(
      queryInBook(
        pool,
        mine.bookId,
        `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
         VALUES ($1, $2, 10, 5000)`,
        [theirs.cash, mine.bookId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a second checkpoint at the same watermark', async () => {
    const book = await seed();

    await queryInBook(
      pool,
      book.bookId,
      `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
       VALUES ($1, $2, 10, 5000)`,
      [book.cash, book.bookId],
    );

    // 23505 is unique_violation. The service inserts ON CONFLICT DO NOTHING; this is what
    // that clause is absorbing.
    await expect(
      queryInBook(
        pool,
        book.bookId,
        `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
         VALUES ($1, $2, 10, 9999)`,
        [book.cash, book.bookId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a watermark of zero', async () => {
    const book = await seed();

    // 23514 is check_violation. An account with no postings has no meaningful watermark,
    // and the service declines to write one rather than storing a row that says nothing.
    await expect(
      queryInBook(
        pool,
        book.bookId,
        `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
         VALUES ($1, $2, 0, 0)`,
        [book.cash, book.bookId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('checkpoint reads and writes', () => {
  it('computes the watermark and the sum in one statement', async () => {
    const book = await bookWith([
      { occurredAt: '2026-01-10T00:00:00.000Z', amountMinor: 5000n },
      { occurredAt: '2026-01-11T00:00:00.000Z', amountMinor: 2500n },
    ]);

    const computed = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.computeCheckpoint(tx, book.cash),
    );

    expect(computed.balanceMinor).toBe(7500n);
    // Two entries, two legs each: cash holds the positive leg of each.
    expect(computed.throughId).toBeGreaterThan(0n);
  });

  it('reports zero and no watermark for an account with no postings', async () => {
    const book = await bookWith([]);

    const computed = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.computeCheckpoint(tx, book.cash),
    );

    expect(computed).toEqual({ throughId: 0n, balanceMinor: 0n });
  });

  it('returns the highest checkpoint, not the newest row', async () => {
    const book = await bookWith([{ occurredAt: '2026-01-10T00:00:00.000Z', amountMinor: 5000n }]);

    await unitOfWork.transactionInBook(book.bookId, async (tx) => {
      // Written in descending watermark order on purpose: "latest" is the highest
      // through_id, not the most recently inserted row.
      await repository.insertCheckpoint(tx, {
        accountId: book.cash, bookId: book.bookId, throughId: 9n, balanceMinor: 900n,
      });
      await repository.insertCheckpoint(tx, {
        accountId: book.cash, bookId: book.bookId, throughId: 4n, balanceMinor: 400n,
      });
    });

    const latest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.latestCheckpoint(tx, book.cash),
    );

    expect(latest?.throughId).toBe(9n);
    expect(latest?.balanceMinor).toBe(900n);
  });

  it('reports whether the insert wrote anything', async () => {
    const book = await bookWith([{ occurredAt: '2026-01-10T00:00:00.000Z', amountMinor: 5000n }]);

    const [first, second] = await unitOfWork.transactionInBook(book.bookId, async (tx) => [
      await repository.insertCheckpoint(tx, {
        accountId: book.cash, bookId: book.bookId, throughId: 3n, balanceMinor: 300n,
      }),
      await repository.insertCheckpoint(tx, {
        accountId: book.cash, bookId: book.bookId, throughId: 3n, balanceMinor: 300n,
      }),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('sums the postings after a watermark, and optionally up to a second one', async () => {
    const book = await bookWith([
      { occurredAt: '2026-01-10T00:00:00.000Z', amountMinor: 5000n },
      { occurredAt: '2026-01-11T00:00:00.000Z', amountMinor: 2500n },
      { occurredAt: '2026-01-12T00:00:00.000Z', amountMinor: 1000n },
    ]);

    // ORDER BY postings.id, qualified, rather than the bare `ORDER BY id` the fixture
    // elsewhere gets away with: this SELECT's output column is also named "id" (the cast
    // does not rename it), and Postgres resolves a bare ORDER BY name against an output
    // column of the same name in preference to the input column. Left unqualified, this
    // would sort the *text* - correct only by accident while every id is one digit, and
    // wrong the moment the suite's shared id sequence reaches double digits.
    const ids = await queryInBook<{ id: string }>(
      pool,
      book.bookId,
      'SELECT id::text FROM postings WHERE account_id = $1 ORDER BY postings.id',
      [book.cash],
    );
    const [first, second] = ids.map((row) => BigInt(row.id));

    const after = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.sumPostingsAfter(tx, book.cash, first!),
    );
    const between = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.sumPostingsAfter(tx, book.cash, first!, second!),
    );

    expect(after).toBe(3500n);
    expect(between).toBe(2500n);
  });
});
