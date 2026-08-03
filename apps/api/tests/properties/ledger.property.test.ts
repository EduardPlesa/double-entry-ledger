import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import { isGuardedAccountType } from '../../src/domain/overdraft.js';
import type { AccountRecord } from '../../src/repositories/ledger.repository.js';
import { entrySpec, toPostEntryInput } from './arbitraries.js';
import { createPropertyBook, OPENING_AT, OPENING_MINOR } from './fixture.js';
import { LedgerModel } from './model.js';
import { propertyRuns } from './runs.js';

/**
 * The ledger's invariants over generated sequences.
 *
 * Against the real database, because the invariants this project is about are enforced half in
 * TypeScript and half in migrations 0003 and 0007. A property run against a reimplementation
 * would prove the reimplementation correct.
 */

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 10 });
});

afterAll(async () => {
  await pool.end();
});

/**
 * Tells the model about the opening entries `createPropertyBook` already posted through the
 * real service, one per currency.
 *
 * The model follows - it records outcomes, it does not predict them - and this opening balance
 * is exactly that: a call that already succeeded, before the case's own generated entries exist
 * to be recorded. `createPropertyBook` does not hand back the entries it posted, so this mirrors
 * its currency/guarded/counterpart grouping instead of duplicating a network round trip to read
 * it back. Both read the same fixed account order out of `accounts`, so the two stay in sync by
 * construction rather than by convention.
 */
function seedOpeningBalances(model: LedgerModel, accounts: readonly AccountRecord[]): void {
  const occurredAt = new Date(OPENING_AT);
  const currencies = [...new Set(accounts.map((account) => account.currency))].sort();

  for (const currency of currencies) {
    const inCurrency = accounts.filter((account) => account.currency === currency);
    const guarded = inCurrency.filter((account) => isGuardedAccountType(account.type));
    const counterpart = inCurrency.find((account) => !isGuardedAccountType(account.type));

    if (guarded.length === 0 || counterpart === undefined) continue;

    model.record({
      id: `opening-${currency}`,
      occurredAt,
      legs: [
        ...guarded.map((account) => ({ accountId: account.id, amountMinor: OPENING_MINOR })),
        { accountId: counterpart.id, amountMinor: -OPENING_MINOR * BigInt(guarded.length) },
      ],
    });
  }
}

describe('a sequence of accepted entries', () => {
  it('leaves the book summing to zero in every currency, and every balance equal to its postings', async () => {
    await fc.assert(
      // `fc.gen()` rather than an arbitrary in the signature, because the generator needs the
      // book's account ids and the book does not exist until the case starts. Values drawn
      // through `gen` still shrink.
      fc.asyncProperty(fc.gen(), async (gen) => {
        const book = await createPropertyBook(pool);
        const model = new LedgerModel(book.accounts);
        seedOpeningBalances(model, book.accounts);

        const count = gen(fc.integer, { min: 1, max: 6 });
        const specs = Array.from({ length: count }, () => gen(entrySpec, book.accounts));

        for (const spec of specs) {
          try {
            const { entry } = await book.service.postEntry(book.bookId, toPostEntryInput(spec));
            model.record({
              id: entry.id,
              occurredAt: entry.occurredAt,
              legs: entry.postings.map((posting) => ({
                accountId: posting.accountId,
                amountMinor: posting.amountMinor,
              })),
            });
          } catch (error) {
            // The only refusal this generator can legitimately provoke.
            if (!(error instanceof AccountOverdrawnError)) throw error;
          }
        }

        const report = await book.service.trialBalance(book.bookId);
        expect(report.balanced).toBe(true);

        for (const [currency, total] of model.totalsByCurrency()) {
          expect(total, `the model's ${currency} total`).toBe(0n);
        }

        for (const account of book.accounts) {
          const actual = await book.service.getBalance(book.bookId, account.id);
          expect(actual.balance.amountMinor, `balance of ${account.name}`).toBe(
            model.balanceOf(account.id),
          );
        }
      }),
      { numRuns: propertyRuns(10) },
    );
  });
});
