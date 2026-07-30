import { newId } from '@ledger/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { balanceOf, insertEntry, minor, seedBook, withClient, type Book } from '../helpers/ledger.js';

/**
 * These run against a real Postgres 16 in a container, migrated by the same code path the
 * dev database uses. Nothing is mocked. A mocked database cannot tell you whether a
 * deferred constraint trigger fires at COMMIT, which is the entire question here.
 */

/** insufficient_privilege - the REVOKE in migration 0002 talking. */
const INSUFFICIENT_PRIVILEGE = '42501';
/** foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = '23503';

let appPool: Pool;
let ownerPool: Pool;

/** One committed entry, reused by the mutation tests as something to try to destroy. */
let recorded: { book: Book; entryId: string };

beforeAll(async () => {
  appPool = new Pool({ connectionString: inject('appUrl'), max: 4 });
  ownerPool = new Pool({ connectionString: inject('ownerUrl'), max: 2 });

  recorded = await withClient(appPool, async (client) => {
    await client.query('BEGIN');
    const book = await seedBook(client);
    const entryId = await insertEntry(client, book, [
      { accountId: book.cash, amountMinor: 1000n },
      { accountId: book.sales, amountMinor: -1000n },
    ]);
    await client.query('COMMIT');
    return { book, entryId };
  });
});

afterAll(async () => {
  await Promise.all([appPool.end(), ownerPool.end()]);
});

describe('zero-sum, deferred to COMMIT', () => {
  it('accepts the INSERT of an unbalanced entry and rejects it at COMMIT', async () => {
    await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const book = await seedBook(client);

      // One leg, €5.00, balanced against nothing.
      const entryId = await insertEntry(client, book, [
        { accountId: book.cash, amountMinor: 500n },
      ]);

      // The INSERT itself succeeded and the row is visible inside the transaction. This is
      // the point of the deferral: an entry is legitimately unbalanced while it is being
      // built, and a constraint that fired here would reject every entry ever written.
      const visible = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM postings WHERE entry_id = $1',
        [entryId],
      );
      expect(visible.rows[0]?.n).toBe(1);

      // The verdict arrives when the transaction claims to be finished.
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: 'LG001' });
    });
  });

  it('commits a balanced two-leg entry', async () => {
    const book = await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const seeded = await seedBook(client);
      await insertEntry(client, seeded, [
        { accountId: seeded.cash, amountMinor: 2500n },
        { accountId: seeded.sales, amountMinor: -2500n },
      ]);
      await client.query('COMMIT');
      return seeded;
    });

    expect(await balanceOf(appPool, book.cash)).toBe(2500n);
    expect(await balanceOf(appPool, book.sales)).toBe(-2500n);
  });

  it('commits a balanced entry with three legs', async () => {
    const book = await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const seeded = await seedBook(client);
      // €30.00 of rent, settled partly from cash and partly from the bank.
      await insertEntry(client, seeded, [
        { accountId: seeded.rent, amountMinor: 3000n },
        { accountId: seeded.cash, amountMinor: -1000n },
        { accountId: seeded.bank, amountMinor: -2000n },
      ]);
      await client.query('COMMIT');
      return seeded;
    });

    expect(await balanceOf(appPool, book.rent)).toBe(3000n);
    expect(await balanceOf(appPool, book.cash)).toBe(-1000n);
    expect(await balanceOf(appPool, book.bank)).toBe(-2000n);
  });

  it('rejects legs that net to zero across currencies but not within them', async () => {
    await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const book = await seedBook(client);

      // Sums to zero if you are willing to add euros to dollars. Nobody is.
      await insertEntry(client, book, [
        { accountId: book.cash, amountMinor: 1000n, currency: 'EUR' },
        { accountId: book.cashUsd, amountMinor: -1000n, currency: 'USD' },
      ]);

      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: 'LG001' });
    });
  });

  it('commits an entry balanced independently in each of two currencies', async () => {
    const book = await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const seeded = await seedBook(client);
      await insertEntry(client, seeded, [
        { accountId: seeded.cash, amountMinor: 1000n, currency: 'EUR' },
        { accountId: seeded.sales, amountMinor: -1000n, currency: 'EUR' },
        { accountId: seeded.cashUsd, amountMinor: 2000n, currency: 'USD' },
        { accountId: seeded.salesUsd, amountMinor: -2000n, currency: 'USD' },
      ]);
      await client.query('COMMIT');
      return seeded;
    });

    expect(await balanceOf(appPool, book.cash)).toBe(1000n);
    expect(await balanceOf(appPool, book.cashUsd)).toBe(2000n);
  });

  it('rejects an entry with no postings at all', async () => {
    // The gap the zero-sum trigger cannot see: it only fires on posting inserts, so a
    // legless entry would commit as vacuously balanced.
    await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const book = await seedBook(client);
      await client.query(
        'INSERT INTO entries (id, book_id, occurred_at, description) VALUES ($1, $2, now(), $3)',
        [newId(), book.bookId, 'an entry with nothing in it'],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: 'LG003' });
    });
  });

  it('holds for amounts far beyond Number.MAX_SAFE_INTEGER', async () => {
    // 2^53 is 9007199254740992. Anything that quietly routed an amount through a JS number
    // would lose the low digits here and the entry would fail to balance.
    const huge = 9_007_199_254_740_993_123n;

    const book = await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const seeded = await seedBook(client);
      await insertEntry(client, seeded, [
        { accountId: seeded.cash, amountMinor: huge },
        { accountId: seeded.sales, amountMinor: -huge },
      ]);
      await client.query('COMMIT');
      return seeded;
    });

    expect(await balanceOf(appPool, book.cash)).toBe(huge);
  });
});

describe('append-only, enforced by privilege (ledger_app)', () => {
  it('refuses UPDATE postings SET amount_minor = 0', async () => {
    await expect(
      appPool.query('UPDATE postings SET amount_minor = $1 WHERE entry_id = $2', [
        minor(0n),
        recorded.entryId,
      ]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('refuses DELETE FROM entries', async () => {
    await expect(
      appPool.query('DELETE FROM entries WHERE id = $1', [recorded.entryId]),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it('refuses TRUNCATE, which no row-level trigger would ever see', async () => {
    await expect(appPool.query('TRUNCATE TABLE postings')).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
  });

  it('left the recorded entry exactly as it was', async () => {
    const result = await appPool.query<{ n: number; total: string }>(
      'SELECT count(*)::int AS n, sum(amount_minor)::text AS total FROM postings WHERE entry_id = $1',
      [recorded.entryId],
    );
    expect(result.rows[0]?.n).toBe(2);
    expect(BigInt(result.rows[0]?.total ?? '-1')).toBe(0n);
  });
});

describe('append-only, enforced by trigger (ledger_owner, which has the privileges)', () => {
  // The second enforcement. ledger_owner is not blocked by any REVOKE - it owns these
  // tables - so anything that stops it here is the trigger from migration 0003.

  it('refuses UPDATE postings', async () => {
    await expect(
      ownerPool.query('UPDATE postings SET amount_minor = $1 WHERE entry_id = $2', [
        minor(1n),
        recorded.entryId,
      ]),
    ).rejects.toMatchObject({ code: 'LG002' });
  });

  it('refuses DELETE FROM entries', async () => {
    await expect(
      ownerPool.query('DELETE FROM entries WHERE id = $1', [recorded.entryId]),
    ).rejects.toMatchObject({ code: 'LG002' });
  });

  it('refuses TRUNCATE postings', async () => {
    await expect(ownerPool.query('TRUNCATE TABLE postings')).rejects.toMatchObject({
      code: 'LG002',
    });
  });
});

describe('a posting cannot escape its account', () => {
  it('rejects a posting whose account belongs to a different book', async () => {
    await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const mine = await seedBook(client);
      const theirs = await seedBook(client);

      // The entry belongs to my book; the account it posts to belongs to theirs.
      await expect(
        insertEntry(client, mine, [{ accountId: theirs.cash, amountMinor: 100n }]),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });

      await client.query('ROLLBACK');
    });
  });

  it('rejects a posting denominated in a currency its account does not hold', async () => {
    await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const book = await seedBook(client);

      // book.cash is a EUR account.
      await expect(
        insertEntry(client, book, [
          { accountId: book.cash, amountMinor: 100n, currency: 'USD' },
        ]),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });

      await client.query('ROLLBACK');
    });
  });
});
