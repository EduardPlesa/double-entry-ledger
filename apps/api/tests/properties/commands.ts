import fc from 'fast-check';
import { expect } from 'vitest';
import type { UnitOfWork } from '../../src/db/client.js';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import type { AccountRecord } from '../../src/repositories/ledger.repository.js';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { entrySpec, hasNegativeGuardedLeg, toPostEntryInput, type EntrySpec } from './arbitraries.js';
import type { LedgerModel } from './model.js';
import { assertGuardedPrefixes } from './prefix.js';

/**
 * The commands a generated sequence is made of, and the invariants checked after each.
 *
 * Reversal is why this is a command sequence rather than a list of entries: it needs an entry
 * that exists and has not already been reversed, which a flat array either cannot express or
 * expresses with indices that shrinking mangles. Commands also shrink to a minimal *sequence*,
 * which is the artifact worth promoting into a regression test.
 */

export interface Real {
  readonly bookId: string;
  readonly service: LedgerService;
  /** For the repository-level cross-check in `prefix.ts`. Nothing writes through it. */
  readonly unitOfWork: UnitOfWork;
}

/** Accept/refuse counts across a whole run. See `tally` in `ledger.property.test.ts`. */
export interface Tally {
  accepted: number;
  refused: number;
}

export type LedgerCommand = fc.AsyncCommand<LedgerModel, Real>;

/**
 * Checked after every command, not only after reads.
 *
 * Invariant 2 - a balance equals the sum of that account's own postings - is the load-bearing
 * one: it ties the model to the database, and every other assertion made against the model is
 * an assertion about real data only because it holds.
 */
export async function assertInvariants(model: LedgerModel, real: Real): Promise<void> {
  // 1. The book sums to zero in every currency.
  for (const [currency, total] of model.totalsByCurrency()) {
    expect(total, `the model's ${currency} total`).toBe(0n);
  }

  // 2. Every balance is the sum of that account's postings.
  for (const account of model.accounts) {
    const actual = await real.service.getBalance(real.bookId, account.id);
    expect(actual.balance.amountMinor, `balance of ${account.name}`).toBe(
      model.balanceOf(account.id),
    );
  }

  // 3. The trial balance agrees, account by account, and states that it balances.
  const report = await real.service.trialBalance(real.bookId);
  expect(report.balanced, 'the trial balance does not balance').toBe(true);

  for (const line of report.accounts) {
    expect(line.balance.amountMinor, `trial balance line for ${line.name}`).toBe(
      model.balanceOf(line.accountId),
    );
  }

  // `report.totals` is computed in-process from the same rows that produced `report.accounts`
  // above, so checking it against itself (debits === credits) proves nothing that isn't already
  // implied by invariant 1 (the model sums to zero per currency) and the per-line check just
  // above. Compare against a total built independently, straight from the model's own account
  // balances, so a bug in how the service rolls rows up into per-currency totals - as opposed to
  // a bug in an individual balance - has something to trip over.
  const modelTotals = new Map<string, { debits: bigint; credits: bigint }>();
  for (const account of model.accounts) {
    const balance = model.balanceOf(account.id);
    if (balance === 0n) continue;

    const totals = modelTotals.get(account.currency) ?? { debits: 0n, credits: 0n };
    if (balance > 0n) totals.debits += balance;
    else totals.credits += -balance;
    modelTotals.set(account.currency, totals);
  }

  for (const total of report.totals) {
    const expected = modelTotals.get(total.currency) ?? { debits: 0n, credits: 0n };
    expect(total.debits.amountMinor, `${total.currency} debits from the model`).toBe(
      expected.debits,
    );
    expect(total.credits.amountMinor, `${total.currency} credits from the model`).toBe(
      expected.credits,
    );
  }

  // 4. No guarded account's minimum running balance is below zero.
  await assertGuardedPrefixes(model, { bookId: real.bookId, unitOfWork: real.unitOfWork });
}

class PostEntryCommand implements LedgerCommand {
  constructor(
    private readonly spec: EntrySpec,
    private readonly tally: Tally,
  ) {}

  check(): boolean {
    return true;
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    try {
      const { entry } = await real.service.postEntry(real.bookId, toPostEntryInput(this.spec));

      model.record({
        id: entry.id,
        occurredAt: entry.occurredAt,
        legs: entry.postings.map((posting) => ({
          accountId: posting.accountId,
          amountMinor: posting.amountMinor,
        })),
      });

      this.tally.accepted += 1;
    } catch (error) {
      // The generator emits only well-formed entries naming real accounts with matching
      // currencies and no zero leg, so an overdraft is the one refusal it can provoke. Anything
      // else - a validation error, a currency mismatch, an unmapped 500 - is a finding, and
      // swallowing it as "the rule refused" is how a property test quietly stops testing.
      if (!(error instanceof AccountOverdrawnError)) throw error;

      // 6. The one liveness claim in the set. An entry with no negative leg on a guarded
      // account cannot lower any prefix - all its legs share one `occurred_at`, its postings
      // take ids above every existing row - so refusing it is a defect, not a decision. This is
      // a consequence of the rule rather than a restatement of it: no prefix scan, no window
      // function, no knowledge of the account's history.
      expect(
        hasNegativeGuardedLeg(this.spec, model),
        `refused an entry that cannot lower any guarded prefix: ${this.toString()}`,
      ).toBe(true);

      this.tally.refused += 1;
    }

    await assertInvariants(model, real);
  }

  toString(): string {
    const legs = this.spec.legs
      .map((leg) => `${leg.accountId.slice(0, 8)}:${leg.amountMinor.toString()}`)
      .join(' ');
    return `PostEntry(${this.spec.occurredAt} ${legs})`;
  }
}

class ReadBalanceCommand implements LedgerCommand {
  constructor(private readonly index: number) {}

  check(model: LedgerModel): boolean {
    return model.accounts.length > 0;
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    const account = model.accounts[this.index % model.accounts.length];
    if (account === undefined) return;

    const actual = await real.service.getBalance(real.bookId, account.id);
    expect(actual.balance.amountMinor, `balance of ${account.name}`).toBe(
      model.balanceOf(account.id),
    );

    await assertInvariants(model, real);
  }

  toString(): string {
    return `ReadBalance(#${this.index.toString()})`;
  }
}

class ReadTrialBalanceCommand implements LedgerCommand {
  check(): boolean {
    return true;
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    await assertInvariants(model, real);
  }

  toString(): string {
    return 'ReadTrialBalance()';
  }
}

class ReverseEntryCommand implements LedgerCommand {
  constructor(
    private readonly index: number,
    private readonly tally: Tally,
  ) {}

  check(model: LedgerModel): boolean {
    // An entry may be reversed at most once, enforced by a partial unique index on
    // `reversal_of`. Picking only from the unreversed ones keeps the command valid rather than
    // making the harness assert about a conflict the generator caused.
    return model.reversibleEntries().length > 0;
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    const candidates = model.reversibleEntries();
    const original = candidates[this.index % candidates.length];
    if (original === undefined) return;

    // 5. A reversal changes each affected balance by exactly the negation of the original's
    // legs. The brief phrases this as "post an entry then reverse it restores the balance",
    // which is the special case where nothing landed in between; this form is stronger and
    // stays checkable in the middle of a sequence, which is where it actually runs.
    const before = new Map(
      model.accounts.map((account) => [account.id, model.balanceOf(account.id)]),
    );

    try {
      const reversal = await real.service.reverseEntry(real.bookId, original.id);

      model.record({
        id: reversal.id,
        occurredAt: reversal.occurredAt,
        legs: reversal.postings.map((posting) => ({
          accountId: posting.accountId,
          amountMinor: posting.amountMinor,
        })),
      });
      model.markReversed(original.id, reversal.id);

      const delta = new Map<string, bigint>();
      for (const leg of original.legs) {
        delta.set(leg.accountId, (delta.get(leg.accountId) ?? 0n) - leg.amountMinor);
      }

      for (const account of model.accounts) {
        const expected = (before.get(account.id) ?? 0n) + (delta.get(account.id) ?? 0n);
        expect(model.balanceOf(account.id), `${account.name} after reversing ${original.id}`).toBe(
          expected,
        );
      }
    } catch (error) {
      // The invariant is a property of the data, not of how the data arrived: a reversal that
      // would drive a guarded account short is refused like any other entry. Nothing is
      // recorded, no delta is asserted, and the entry stays reversible.
      if (!(error instanceof AccountOverdrawnError)) throw error;
      this.tally.refused += 1;
    }

    await assertInvariants(model, real);
  }

  toString(): string {
    return `ReverseEntry(#${this.index.toString()})`;
  }
}

export function ledgerCommands(
  accounts: readonly AccountRecord[],
  tally: Tally,
): fc.Arbitrary<Iterable<LedgerCommand>> {
  // `check` is synchronous on every command here (`CheckAsync = false`), but the third type
  // argument still has to be given explicitly: with only two, overload resolution picks the
  // sync-`Command` overload instead, and every command below returns a `Promise<void>` from
  // `run`.
  return fc.commands<LedgerModel, Real, false>(
    [
      // Weighted towards writes: a sequence of reads against an empty book asserts very little,
      // and the interesting states are the ones several entries deep.
      entrySpec(accounts).map((spec): LedgerCommand => new PostEntryCommand(spec, tally)),
      entrySpec(accounts).map((spec): LedgerCommand => new PostEntryCommand(spec, tally)),
      fc.nat().map((index): LedgerCommand => new ReverseEntryCommand(index, tally)),
      fc.nat().map((index): LedgerCommand => new ReadBalanceCommand(index)),
      fc.constant(new ReadTrialBalanceCommand()),
    ],
    { maxCommands: 12 },
  );
}
