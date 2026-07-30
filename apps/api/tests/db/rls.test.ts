import { newId } from '@ledger/shared';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { insertEntry, seedBook, withClient, type Book } from '../helpers/ledger.js';

/**
 * Row-level security, exercised with direct SQL as ledger_app.
 *
 * Deliberately not through the service. Going through the service would prove that the
 * service remembers to set `app.current_book_id`, which is a fact about the service; the
 * question here is what the database does to a statement that forgets - including one typed
 * into psql, or written by a future repository method that never learned the convention.
 *
 * Seeding happens as ledger_owner, which the policies do not apply to. That is the same
 * exemption migrations rely on, and using it here keeps the fixtures independent of the
 * thing under test.
 */

/** insufficient_privilege. What a WITH CHECK violation is reported as. */
const INSUFFICIENT_PRIVILEGE = '42501';

let appPool: Pool;
let ownerPool: Pool;

/** Two books with data in each, so "returns nothing" can be told from "there is nothing". */
let mine: Book;
let theirs: Book;
let myEntryId: string;

beforeAll(async () => {
  appPool = new Pool({ connectionString: inject('appUrl'), max: 4 });
  ownerPool = new Pool({ connectionString: inject('ownerUrl'), max: 2 });

  const seeded = await withClient(ownerPool, async (client) => {
    await client.query('BEGIN');
    const first = await seedBook(client);
    const second = await seedBook(client);

    const entryId = await insertEntry(client, first, [
      { accountId: first.cash, amountMinor: 2500n },
      { accountId: first.sales, amountMinor: -2500n },
    ]);

    await insertEntry(client, second, [
      { accountId: second.cash, amountMinor: 700n },
      { accountId: second.sales, amountMinor: -700n },
    ]);

    await client.query('COMMIT');
    return { first, second, entryId };
  });

  mine = seeded.first;
  theirs = seeded.second;
  myEntryId = seeded.entryId;
});

afterAll(async () => {
  await Promise.all([appPool.end(), ownerPool.end()]);
});

/** Runs `fn` in a transaction with the book context set, then rolls back. */
async function inBook<T>(bookId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(appPool, async (client) => {
    await client.query('BEGIN');
    try {
      if (bookId !== null) {
        await client.query("SELECT set_config('app.current_book_id', $1, true)", [bookId]);
      }
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

async function countVisible(client: PoolClient, table: string): Promise<number> {
  const result = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0]?.n ?? 0;
}

describe('a statement with no book context', () => {
  it('sees no accounts, entries or postings at all', async () => {
    await inBook(null, async (client) => {
      expect(await countVisible(client, 'accounts')).toBe(0);
      expect(await countVisible(client, 'entries')).toBe(0);
      expect(await countVisible(client, 'postings')).toBe(0);
    });
  });

  it('cannot see a row it names directly either', async () => {
    // A policy that filtered only unqualified scans would pass the test above and leak here.
    await inBook(null, async (client) => {
      const result = await client.query('SELECT id FROM accounts WHERE id = $1', [mine.cash]);
      expect(result.rowCount).toBe(0);
    });
  });

  it('returns zero rows rather than raising', async () => {
    // The failure mode matters as much as the fact of it: an exception from inside a policy
    // is a 500 with an obscure cause, and it is also the shape that tempts someone to make
    // the unset case permissive so the error goes away.
    await inBook(null, async (client) => {
      await expect(client.query('SELECT count(*) FROM postings')).resolves.toBeDefined();
    });
  });

  it('cannot insert', async () => {
    await inBook(null, async (client) => {
      await expect(
        client.query('INSERT INTO accounts (id, book_id, name, type, currency) VALUES ($1, $2, $3, $4, $5)', [
          newId(),
          mine.bookId,
          'Smuggled',
          'asset',
          'EUR',
        ]),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });
  });
});

describe('a statement scoped to the wrong book', () => {
  it('sees none of the other book’s rows', async () => {
    await inBook(theirs.bookId, async (client) => {
      const accounts = await client.query('SELECT id FROM accounts WHERE id = $1', [mine.cash]);
      const entries = await client.query('SELECT id FROM entries WHERE id = $1', [myEntryId]);
      const postings = await client.query('SELECT id FROM postings WHERE entry_id = $1', [myEntryId]);

      expect(accounts.rowCount).toBe(0);
      expect(entries.rowCount).toBe(0);
      expect(postings.rowCount).toBe(0);
    });
  });

  it('cannot write a row belonging to another book', async () => {
    // This is what WITH CHECK buys. Without it, the insert succeeds and the row promptly
    // becomes invisible to the caller who created it.
    await inBook(theirs.bookId, async (client) => {
      await expect(
        client.query('INSERT INTO accounts (id, book_id, name, type, currency) VALUES ($1, $2, $3, $4, $5)', [
          newId(),
          mine.bookId,
          'Smuggled',
          'asset',
          'EUR',
        ]),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });
  });
});

describe('a statement scoped to the right book', () => {
  it('sees that book’s rows and only those', async () => {
    await inBook(mine.bookId, async (client) => {
      const accounts = await client.query<{ book_id: string }>('SELECT book_id FROM accounts');
      expect(accounts.rowCount).toBe(6);
      expect(accounts.rows.every((row) => row.book_id === mine.bookId)).toBe(true);

      const entries = await client.query('SELECT id FROM entries WHERE id = $1', [myEntryId]);
      expect(entries.rowCount).toBe(1);

      const postings = await client.query('SELECT id FROM postings WHERE entry_id = $1', [myEntryId]);
      expect(postings.rowCount).toBe(2);
    });
  });

  it('can write to it', async () => {
    await inBook(mine.bookId, async (client) => {
      await expect(
        client.query('INSERT INTO accounts (id, book_id, name, type, currency) VALUES ($1, $2, $3, $4, $5)', [
          newId(),
          mine.bookId,
          'Petty cash',
          'asset',
          'EUR',
        ]),
      ).resolves.toBeDefined();
    });
  });
});

describe('the context is transaction-local', () => {
  it('does not survive the transaction that set it', async () => {
    // The whole reason for `set_config(..., true)` over a session-level SET. Connections
    // outlive requests, and a setting that outlived its transaction would be waiting for
    // whoever borrowed the connection next.
    await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_book_id', $1, true)", [mine.bookId]);
      expect(await countVisible(client, 'accounts')).toBeGreaterThan(0);
      await client.query('COMMIT');

      expect(await countVisible(client, 'accounts')).toBe(0);
    });
  });
});

describe('the book lookup functions', () => {
  it('resolve an account and an entry without any context set', async () => {
    // The cycle-breaker: the caller has an id and no book, and this is how they get one.
    await inBook(null, async (client) => {
      const account = await client.query<{ book_id: string | null }>(
        'SELECT book_of_account($1) AS book_id',
        [mine.cash],
      );
      const entry = await client.query<{ book_id: string | null }>('SELECT book_of_entry($1) AS book_id', [
        myEntryId,
      ]);

      expect(account.rows[0]?.book_id).toBe(mine.bookId);
      expect(entry.rows[0]?.book_id).toBe(mine.bookId);
    });
  });

  it('return null for an id that does not exist', async () => {
    await inBook(null, async (client) => {
      const result = await client.query<{ book_id: string | null }>(
        'SELECT book_of_account($1) AS book_id',
        [newId()],
      );
      expect(result.rows[0]?.book_id).toBeNull();
    });
  });

  it('reveal the book and nothing else', async () => {
    // A one-column function is the entire safety argument for running it as the owner. If it
    // ever returns a row, this test is the thing that says so.
    const result = await appPool.query<{ result_type: string }>(
      `SELECT pg_catalog.format_type(p.prorettype, NULL) AS result_type
       FROM pg_catalog.pg_proc p
       WHERE p.proname IN ('book_of_account', 'book_of_entry')`,
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.result_type === 'uuid')).toBe(true);
  });
});
