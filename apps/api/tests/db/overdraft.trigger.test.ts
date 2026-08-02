import { readFileSync } from 'node:fs';
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

/**
 * Migration 0007's validation block, run against data that violates the rule.
 *
 * `CREATE CONSTRAINT TRIGGER` binds future inserts and says nothing about the rows already in
 * the table, so applying 0007 to a database that is already in violation would have succeeded
 * and left the violation in place - where the service's negative-leg-only optimisation cannot
 * see it and a later *deposit* trips the trigger at COMMIT with no account id and no shortfall
 * to report. The `DO` block exists to make applying the migration establish the assumption the
 * optimisation rests on.
 *
 * Every migration run in this suite exercises the passing half of that already: the block runs
 * against a clean database on the way to every test in the project. What it cannot show is
 * that the block would *catch* anything, and a validation that silently passes on everything
 * is indistinguishable from no validation at all. So this manufactures the situation directly -
 * inserting a negative-leg posting is an ordinary `INSERT`, unremarkable to the trigger that
 * would otherwise reject it because that trigger is `DEFERRABLE INITIALLY DEFERRED` and this
 * transaction never commits, so the queued check never runs - and then runs the migration's own
 * text, extracted from the file rather than retyped, so that this cannot drift away from what
 * actually ships.
 *
 * `ownerPool` is what the migration itself runs as, not a workaround: `ledger_owner` is exempt
 * from the row-level security policies migration 0006 puts on `accounts`, `entries` and
 * `postings`, because a table's owner bypasses its own policies unless `FORCE ROW LEVEL
 * SECURITY` is set, and it is not. That is what lets the `DO` block's unscoped scan see every
 * book rather than only the one `app.current_book_id` happens to name - which is exactly the
 * privilege a real migration run has and a run through `ledger_app` would not.
 *
 * The whole thing is rolled back. Nothing else in the suite ever sees the account.
 */
describe("migration 0007's validation of the rows that were already there", () => {
  let ownerPool: Pool;

  beforeAll(() => {
    ownerPool = new Pool({ connectionString: inject('ownerUrl'), max: 2 });
  });

  afterAll(async () => {
    await ownerPool.end();
  });

  /** The `DO $$ ... $$` statement out of the migration, so the test cannot drift from it. */
  function validationBlock(): string {
    const migration = readFileSync(
      new URL('../../drizzle/0007_overdraft.sql', import.meta.url),
      'utf8',
    );

    // By content rather than by position, and the leading comment block comes along with it:
    // the statement is what the migrator sends, comments included, so this stays the same
    // text even if the file is reordered or the commentary is rewritten.
    const block = migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .find((statement) => /^DO \$\$/m.test(statement));

    if (block === undefined) {
      throw new Error('0007_overdraft.sql no longer contains a DO block to validate with');
    }

    return block;
  }

  it('raises LG004 naming the account that is already negative', async () => {
    const attempt = withClient(ownerPool, async (client) => {
      await client.query('BEGIN');
      try {
        const book = await seedBook(client);

        await insertEntry(
          client,
          book,
          [
            { accountId: book.cash, amountMinor: -2500n },
            { accountId: book.sales, amountMinor: 2500n },
          ],
          { occurredAt: '2026-01-01T00:00:00.000Z' },
        );

        await client.query(validationBlock());
      } finally {
        // Rolled back whether the block raised or not: the disabled trigger and the negative
        // account both disappear with the transaction.
        await client.query('ROLLBACK');
      }
    });

    await expect(attempt).rejects.toMatchObject({ code: ACCOUNT_OVERDRAWN });
  });

  it('passes over an account that never goes short', async () => {
    await withClient(ownerPool, async (client) => {
      await client.query('BEGIN');
      try {
        const book = await seedBook(client);

        await insertEntry(
          client,
          book,
          [
            { accountId: book.cash, amountMinor: 2500n },
            { accountId: book.sales, amountMinor: -2500n },
          ],
          { occurredAt: '2026-01-01T00:00:00.000Z' },
        );

        // No exception, and that is the assertion: a healthy book applies the migration.
        await client.query(validationBlock());
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
