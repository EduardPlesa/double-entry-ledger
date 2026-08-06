import { formatMoney, money } from '@ledger/shared';
import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { accountsOf, seedBookIn } from '../helpers/ledger.js';
import { assertCheckpointAgreement } from './checkpoint.js';
import { ledgerCommands, type Real, type Tally } from './commands.js';
import { createPropertyBook, type PropertyBook } from './fixture.js';
import { propertyRuns } from './runs.js';

/**
 * The checkpointed balance and the sum-from-zero balance, compared after arbitrary sequences
 * of entries, reversals and checkpoints.
 *
 * Against the real database, for the same reason `ledger.property.test.ts` is: the invariant
 * under test - `balanceThrough` resuming correctly from a checkpoint - is a property of the
 * repository's SQL and the service's branch between them, not of a reimplementation.
 */

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 10 });
});

afterAll(async () => {
  await pool.end();
});

/** The `Real` object `ledger.property.test.ts` constructs inline, built from a `PropertyBook`. */
function realOf(book: PropertyBook): Real {
  return { bookId: book.bookId, service: book.service, unitOfWork: book.unitOfWork };
}

describe('arbitrary sequences of entries, reversals and checkpoints', () => {
  /**
   * Arbitrary sequences, with checkpoints taken at arbitrary moments inside them.
   *
   * The checkpoints are the point. Taking one only at the end would test a suffix sum of
   * length zero; taking them partway through a sequence that keeps writing - including
   * backdated entries and reversals, which is what `ledgerCommands` generates - is what puts
   * a watermark behind entries that arrive later.
   */
  it('a checkpointed balance always equals the sum from zero', async () => {
    const tally: Tally = { accepted: 0, refused: 0, reversalsAccepted: 0, reversalsRefused: 0 };
    const shape = accountsOf(await seedBookIn(pool));
    const commands = ledgerCommands(shape, tally);

    await fc.assert(
      fc.asyncProperty(
        commands,
        // Where in the sequence to checkpoint, and which account. Indices, resolved against
        // this case's own accounts inside the run, for the same reason the commands are.
        fc.array(fc.nat({ max: 40 }), { minLength: 1, maxLength: 4 }),
        async (commands, checkpointAt) => {
          const book = await createPropertyBook(pool);
          const model = book.newModel();
          const real = realOf(book);
          const points = new Set(checkpointAt);

          // Driven with a plain loop rather than a single `fc.asyncModelRun(setup, commands)`
          // call, so a checkpoint sweep can be interleaved between individual commands. That
          // is still `fc.asyncModelRun` underneath - called once per command, with a
          // one-element array - not a hand-rolled `check`/`run` dispatch: this fast-check
          // version's `asyncModelRun` takes any `Iterable<AsyncCommand>`, so `[command]` is a
          // valid (length-one) iterable and the shrinker-relevant behaviour (pre/postConditions,
          // `toString()` on failure) stays exactly what the library provides.
          let index = 0;
          for (const command of commands) {
            await fc.asyncModelRun(() => ({ model, real }), [command]);

            if (points.has(index)) {
              for (const account of book.accounts) {
                await book.service.checkpointAccount(book.bookId, account.id);
              }
            }
            index += 1;
          }

          await assertCheckpointAgreement(book);
        },
      ),
      { numRuns: propertyRuns() },
    );

    // The same vacuous-truth guard `ledger.property.test.ts` applies: a run whose generated
    // sequences were all refused would agree the two paths agree without either path ever
    // having summed anything interesting.
    expect(tally.accepted, 'no entry was ever accepted').toBeGreaterThan(0);
  });
});

/**
 * The two shapes the design exists for, pinned so a generator change cannot quietly stop
 * covering them. A shrunk counterexample is a fine way to find a bug and a poor way to keep
 * a guarantee.
 */
describe('checkpoints behind later writes', () => {
  it('survives an entry backdated behind the watermark', async () => {
    const book = await createPropertyBook(pool);
    const cash = book.accounts.find((account) => account.name === 'Cash');
    const sales = book.accounts.find((account) => account.name === 'Sales');
    if (cash === undefined || sales === undefined) {
      throw new Error('the property fixture no longer seeds a Cash/Sales pair');
    }

    await book.service.postEntry(book.bookId, {
      occurredAt: '2026-02-10T00:00:00.000Z',
      description: 'a sale',
      legs: [
        { accountId: cash.id, amount: formatMoney(money(5_000n, 'EUR')), currency: 'EUR' },
        { accountId: sales.id, amount: formatMoney(money(-5_000n, 'EUR')), currency: 'EUR' },
      ],
    });

    for (const account of book.accounts) {
      await book.service.checkpointAccount(book.bookId, account.id);
    }

    // Recorded now, occurred before everything just checkpointed. Its posting id still lands
    // above every checkpoint's watermark - the entire argument for keying on id rather than
    // on `occurred_at`.
    await book.service.postEntry(book.bookId, {
      occurredAt: '2026-01-05T00:00:00.000Z',
      description: 'a backdated sale',
      legs: [
        { accountId: cash.id, amount: formatMoney(money(1_000n, 'EUR')), currency: 'EUR' },
        { accountId: sales.id, amount: formatMoney(money(-1_000n, 'EUR')), currency: 'EUR' },
      ],
    });

    await assertCheckpointAgreement(book);
  });

  it('survives a reversal recorded after the watermark', async () => {
    const book = await createPropertyBook(pool);
    const cash = book.accounts.find((account) => account.name === 'Cash');
    const sales = book.accounts.find((account) => account.name === 'Sales');
    if (cash === undefined || sales === undefined) {
      throw new Error('the property fixture no longer seeds a Cash/Sales pair');
    }

    const { entry } = await book.service.postEntry(book.bookId, {
      occurredAt: '2026-02-10T00:00:00.000Z',
      description: 'a sale',
      legs: [
        { accountId: cash.id, amount: formatMoney(money(5_000n, 'EUR')), currency: 'EUR' },
        { accountId: sales.id, amount: formatMoney(money(-5_000n, 'EUR')), currency: 'EUR' },
      ],
    });

    for (const account of book.accounts) {
      await book.service.checkpointAccount(book.bookId, account.id);
    }

    // The reversal's postings are recorded after every checkpoint above, on an entry the
    // checkpoints already summed.
    await book.service.reverseEntry(book.bookId, entry.id);

    await assertCheckpointAgreement(book);
  });
});
