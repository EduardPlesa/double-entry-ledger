import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GUARDED_ACCOUNT_TYPES } from '../../src/domain/overdraft.js';
import { insertEntry, queryInBook, seedBook, withClient } from '../helpers/ledger.js';

/**
 * The overdraft rule as the database sees it.
 *
 * These insert straight through SQL, so nothing in `ledger.service.ts` is involved. That is
 * the whole question: an invariant only the application enforces is an invariant that a
 * migration script, a psql session or a future bug can walk straight past.
 */

/** Ledger: a guarded account would be left negative. Raised at COMMIT. */
const ACCOUNT_OVERDRAWN = 'LG004';

let appPool: Pool;

beforeAll(() => {
  appPool = new Pool({ connectionString: inject('appUrl'), max: 4 });
});

afterAll(async () => {
  await appPool.end();
});

describe('guarded_account_types()', () => {
  it('agrees with the application', async () => {
    const book = await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const seeded = await seedBook(client);
      await client.query('COMMIT');
      return seeded;
    });

    const rows = await queryInBook<{ types: string[] }>(
      appPool,
      book.bookId,
      'SELECT guarded_account_types()::text[] AS types',
    );

    expect(rows[0]?.types).toEqual([...GUARDED_ACCOUNT_TYPES]);
  });
});

describe('LG004, deferred to COMMIT', () => {
  it('rejects an entry that leaves an asset account negative', async () => {
    await expect(
      withClient(appPool, async (client) => {
        await client.query('BEGIN');
        const book = await seedBook(client);

        // Straight to -5.00 with no opening balance at all.
        await insertEntry(client, book, [
          { accountId: book.cash, amountMinor: -500n },
          { accountId: book.rent, amountMinor: 500n },
        ]);

        await client.query('COMMIT');
      }),
    ).rejects.toMatchObject({ code: ACCOUNT_OVERDRAWN });
  });

  it('leaves unguarded types alone', async () => {
    await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const book = await seedBook(client);

      // Revenue at -10.00 is an ordinary credit balance.
      await insertEntry(client, book, [
        { accountId: book.cash, amountMinor: 1000n },
        { accountId: book.sales, amountMinor: -1000n },
      ]);

      await client.query('COMMIT');
    });
  });

  it('rejects a backdated withdrawal that dips a historical prefix', async () => {
    await expect(
      withClient(appPool, async (client) => {
        await client.query('BEGIN');
        const book = await seedBook(client);

        await insertEntry(
          client,
          book,
          [
            { accountId: book.cash, amountMinor: 1000n },
            { accountId: book.sales, amountMinor: -1000n },
          ],
          { occurredAt: '2026-03-01T00:00:00.000Z' },
        );

        await insertEntry(
          client,
          book,
          [
            { accountId: book.cash, amountMinor: 10_000n },
            { accountId: book.sales, amountMinor: -10_000n },
          ],
          { occurredAt: '2026-04-01T00:00:00.000Z' },
        );

        // Ends at +60.00, but on 15 March the account holds 10.00 and this takes 50.00.
        await insertEntry(
          client,
          book,
          [
            { accountId: book.cash, amountMinor: -5000n },
            { accountId: book.rent, amountMinor: 5000n },
          ],
          { occurredAt: '2026-03-15T00:00:00.000Z' },
        );

        await client.query('COMMIT');
      }),
    ).rejects.toMatchObject({ code: ACCOUNT_OVERDRAWN });
  });
});
