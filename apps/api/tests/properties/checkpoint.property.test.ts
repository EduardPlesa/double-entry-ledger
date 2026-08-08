import { formatMoney, money } from '@ledger/shared';
import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
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
const repository = new DrizzleLedgerRepository();

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
    // Cases where a checkpoint actually got to resume with later writes above its watermark -
    // the scenario the design exists for. A checkpoint taken as the very last thing in a
    // sequence proves nothing (empty suffix), so this only counts when it wasn't.
    const coverage = { casesWithLaterWrites: 0 };
    const shape = accountsOf(await seedBookIn(pool));
    const commands = ledgerCommands(shape, tally);

    await fc.assert(
      fc.asyncProperty(
        commands,
        // Raw draws, deliberately not pre-bounded to the sequence length: `ledgerCommands`
        // caps a sequence at 12 (`maxCommands`) but its actual length varies per case and
        // isn't known until `commands` is generated alongside this. Bounded to the real
        // length below, by the same modulo technique `ReadBalanceCommand` and
        // `ReverseEntryCommand` already use for their own indices - the earlier version of
        // this arbitrary used `fc.nat({ max: 40 })` directly as an index against sequences of
        // at most 12, so most draws landed past the end and checkpointed nothing new.
        fc.array(fc.nat({ max: 40 }), { minLength: 1, maxLength: 4 }),
        async (commands, checkpointAt) => {
          const book = await createPropertyBook(pool);
          const model = book.newModel();
          const real = realOf(book);
          const commandArray = [...commands];
          const points = new Set(
            commandArray.length === 0 ? [] : checkpointAt.map((n) => n % commandArray.length),
          );

          // Driven with a plain loop rather than a single `fc.asyncModelRun(setup, commands)`
          // call, so a checkpoint sweep can be interleaved between individual commands. That
          // is still `fc.asyncModelRun` underneath - called once per command, with a
          // one-element array - not a hand-rolled `check`/`run` dispatch: this fast-check
          // version's `asyncModelRun` takes any `Iterable<AsyncCommand>`, so `[command]` is a
          // valid (length-one) iterable and the shrinker-relevant behaviour (pre/postConditions,
          // `toString()` on failure) stays exactly what the library provides.
          let index = 0;
          for (const command of commandArray) {
            await fc.asyncModelRun(() => ({ model, real }), [command]);

            if (points.has(index)) {
              for (const account of book.accounts) {
                await book.service.checkpointAccount(book.bookId, account.id);
              }
            }
            index += 1;
          }

          await assertCheckpointAgreement(book);

          // Did any account, in this case, end up resuming from a checkpoint that isn't also
          // the latest posting - i.e. a checkpoint with at least one posting recorded above
          // its watermark? `computeCheckpoint` reports the current max posting id "for free"
          // (it is exactly what a fresh checkpoint would write), so comparing it against the
          // latest checkpoint's `throughId` answers this without summing anything.
          const resumedWithLaterWrites = await book.unitOfWork.transactionInBook(
            book.bookId,
            async (tx) => {
              for (const account of book.accounts) {
                const checkpoint = await repository.latestCheckpoint(tx, account.id);
                if (checkpoint === null) continue;

                const computed = await repository.computeCheckpoint(tx, account.id);
                if (computed.throughId > checkpoint.throughId) return true;
              }
              return false;
            },
          );

          if (resumedWithLaterWrites) coverage.casesWithLaterWrites += 1;
        },
      ),
      { numRuns: propertyRuns() },
    );

    // The same vacuous-truth guard `ledger.property.test.ts` applies: a run whose generated
    // sequences were all refused would agree the two paths agree without either path ever
    // having summed anything interesting.
    expect(tally.accepted, 'no entry was ever accepted').toBeGreaterThan(0);

    // And the guard specific to this file: a run where every checkpoint happened to land on
    // (or after) the last write would agree the two paths agree without ever putting a
    // checkpoint in the position it exists for - resumed from, with something above it.
    expect(
      coverage.casesWithLaterWrites,
      'no case ever resumed from a checkpoint with writes landing above its watermark',
    ).toBeGreaterThan(0);
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
