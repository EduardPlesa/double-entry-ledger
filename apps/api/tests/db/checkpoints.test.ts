import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { queryInBook, seedBook, withClient } from '../helpers/ledger.js';

/**
 * The checkpoint table's guarantees, at the level the database enforces them.
 *
 * A checkpoint is derived data - it can always be recomputed from the postings - so the
 * interesting assertions are not about its content but about who may change it. Append-only
 * for the runtime role, invisible across books, and impossible to attach to an account in
 * another book.
 */

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 4 });
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
