import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ledgerCommands, type Real, type Tally } from './commands.js';
import { createPropertyBook } from './fixture.js';
import { propertyRuns } from './runs.js';

/**
 * The ledger's invariants over generated command sequences.
 *
 * Against the real database, because the invariants this project is about are enforced half in
 * TypeScript and half in migrations 0003 and 0007. A property run against a reimplementation
 * would prove the reimplementation correct and say nothing about the triggers, the deferred
 * constraint or the prefix rule's window function.
 */

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 10 });
});

afterAll(async () => {
  await pool.end();
});

describe('arbitrary sequences of valid entries', () => {
  it('hold every invariant after every command', async () => {
    // Accumulated across the whole run rather than per case, and asserted afterwards. Because
    // the model never predicts a refusal, a service that refused *everything* would satisfy
    // every state invariant above - vacuous truth is the standing failure mode of property
    // testing, and this is the guard against it. It also catches a generator that has drifted
    // into producing entries nothing will accept, which is the same failure and likelier.
    const tally: Tally = { accepted: 0, refused: 0 };

    await fc.assert(
      fc.asyncProperty(fc.gen(), async (gen) => {
        const book = await createPropertyBook(pool);
        const real: Real = { bookId: book.bookId, service: book.service };

        const commands = gen(ledgerCommands, book.accounts, tally);

        // `book.newModel()`, never `new LedgerModel(book.accounts)`: the fixture already posted
        // the opening entries, so a model that started empty would be off by exactly the opening
        // balance on every guarded account.
        await fc.asyncModelRun(() => ({ model: book.newModel(), real }), commands);
      }),
      { numRuns: propertyRuns() },
    );

    expect(tally.accepted, 'no entry was ever accepted').toBeGreaterThan(0);
    expect(tally.refused, 'no entry was ever refused: the overdraft rule went untested').toBeGreaterThan(0);
    expect(
      tally.accepted,
      `only ${tally.accepted.toString()} of ${(tally.accepted + tally.refused).toString()} entries were accepted`,
    ).toBeGreaterThan(tally.refused);
  });
});
