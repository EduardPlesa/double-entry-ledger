import { newId } from '@ledger/shared';
import type { Pool, PoolClient } from 'pg';

/**
 * Amounts are passed to the driver as strings and read back as strings.
 *
 * node-postgres does not serialise a JS bigint parameter, and it returns int8 columns as
 * strings by default precisely because a value beyond 2^53 cannot survive the trip
 * through a JS number. Both directions stay textual here, and the conversion to bigint is
 * explicit. No amount is ever a number, not even briefly, not even in a test.
 */
export const minor = (amount: bigint): string => amount.toString();

export interface Book {
  bookId: string;
  /** asset, EUR */
  cash: string;
  /** asset, EUR */
  bank: string;
  /** revenue, EUR */
  sales: string;
  /** expense, EUR */
  rent: string;
  /** asset, USD - for the per-currency grouping cases */
  cashUsd: string;
  /** revenue, USD */
  salesUsd: string;
}

/**
 * Establishes the book context row-level security is keyed on, for the current transaction.
 *
 * Transaction-local, which is the same thing `db/client.ts` does and for the same reason:
 * connections outlive the work that borrowed them, and a session-level setting would still
 * be in place for whoever borrows this one next.
 */
export async function setBookContext(client: PoolClient, bookId: string): Promise<void> {
  await client.query("SELECT set_config('app.current_book_id', $1, true)", [bookId]);

  // Outside a transaction, `set_config(..., true)` scopes the setting to the implicit
  // single-statement transaction and it is gone by the next query - so the caller would get
  // an opaque row-level security violation several statements later instead of being told
  // what they actually did wrong.
  const check = await client.query<{ value: string }>(
    "SELECT current_setting('app.current_book_id', true) AS value",
  );

  if (check.rows[0]?.value !== bookId) {
    throw new Error('the book context did not stick: this must run inside an explicit transaction');
  }
}

/**
 * A fresh book with a handful of accounts.
 *
 * Every test seeds its own, because this database has no teardown: entries and postings
 * cannot be deleted or truncated, by design. Isolation comes from disjoint books rather
 * than from cleaning up, which is the same thing the production system has to do.
 *
 * Must run inside a transaction, and leaves the new book as the current one. `books` has no
 * policy - a caller has to be able to find their books before one of them can be current -
 * but `accounts` does, so the context has to exist before the first account is inserted.
 */
export async function seedBook(client: PoolClient): Promise<Book> {
  const bookId = newId();
  await client.query('INSERT INTO books (id, name, base_currency) VALUES ($1, $2, $3)', [
    bookId,
    `test book ${bookId}`,
    'EUR',
  ]);

  await setBookContext(client, bookId);

  const account = async (name: string, type: string, currency: string): Promise<string> => {
    const id = newId();
    await client.query(
      'INSERT INTO accounts (id, book_id, name, type, currency) VALUES ($1, $2, $3, $4, $5)',
      [id, bookId, name, type, currency],
    );
    return id;
  };

  return {
    bookId,
    cash: await account('Cash', 'asset', 'EUR'),
    bank: await account('Bank', 'asset', 'EUR'),
    sales: await account('Sales', 'revenue', 'EUR'),
    rent: await account('Rent', 'expense', 'EUR'),
    cashUsd: await account('Cash USD', 'asset', 'USD'),
    salesUsd: await account('Sales USD', 'revenue', 'USD'),
  };
}

/** `seedBook` in a transaction of its own, for callers that only want the fixture. */
export async function seedBookIn(pool: Pool): Promise<Book> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const book = await seedBook(client);
      await client.query('COMMIT');
      return book;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export interface Leg {
  accountId: string;
  amountMinor: bigint;
  /** Defaults to EUR. Must match the account's own currency. */
  currency?: string;
}

/**
 * Inserts an entry and its postings. Deliberately does not open or close a transaction:
 * whether these statements commit is the thing under test.
 */
export async function insertEntry(
  client: PoolClient,
  book: Book,
  legs: readonly Leg[],
  options: { description?: string; externalId?: string | null } = {},
): Promise<string> {
  const entryId = newId();

  await client.query(
    `INSERT INTO entries (id, book_id, occurred_at, description, external_id)
     VALUES ($1, $2, now(), $3, $4)`,
    [entryId, book.bookId, options.description ?? 'test entry', options.externalId ?? null],
  );

  for (const leg of legs) {
    await client.query(
      `INSERT INTO postings (entry_id, book_id, account_id, amount_minor, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [entryId, book.bookId, leg.accountId, minor(leg.amountMinor), leg.currency ?? 'EUR'],
    );
  }

  return entryId;
}

/** Borrows a connection, guarantees it goes back to the pool. */
export async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Borrows a connection, opens a transaction with the book context set, and commits.
 *
 * Every read of accounts, entries or postings needs this now. A bare pool query sees no rows
 * at all - not an error, just nothing - which is exactly the failure row-level security is
 * designed to produce and exactly the one that would make a test silently assert about an
 * empty table.
 */
export async function withBookClient<T>(
  pool: Pool,
  bookId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await setBookContext(client, bookId);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** Sum of every posting on an account, read as a bigint. */
export async function balanceOf(pool: Pool, bookId: string, accountId: string): Promise<bigint> {
  return withBookClient(pool, bookId, async (client) => {
    const result = await client.query<{ total: string }>(
      'SELECT coalesce(sum(amount_minor), 0)::text AS total FROM postings WHERE account_id = $1',
      [accountId],
    );
    return BigInt(result.rows[0]?.total ?? '0');
  });
}
