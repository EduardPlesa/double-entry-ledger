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
 * A fresh book with a handful of accounts.
 *
 * Every test seeds its own, because this database has no teardown: entries and postings
 * cannot be deleted or truncated, by design. Isolation comes from disjoint books rather
 * than from cleaning up, which is the same thing the production system has to do.
 */
export async function seedBook(client: PoolClient): Promise<Book> {
  const bookId = newId();
  await client.query('INSERT INTO books (id, name, base_currency) VALUES ($1, $2, $3)', [
    bookId,
    `test book ${bookId}`,
    'EUR',
  ]);

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

/** Sum of every posting on an account, read as a bigint. */
export async function balanceOf(pool: Pool, accountId: string): Promise<bigint> {
  const result = await pool.query<{ total: string }>(
    'SELECT coalesce(sum(amount_minor), 0)::text AS total FROM postings WHERE account_id = $1',
    [accountId],
  );
  return BigInt(result.rows[0]?.total ?? '0');
}
