import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { ConcurrencyStrategy } from '../../src/db/client.js';
import { SQLSTATE, hasSqlState } from '../../src/db/pg-errors.js';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { fireConcurrently, fundedBook } from '../helpers/concurrency.js';
import { balanceOf } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * The race the row locks close.
 *
 * `evidence/overdraft-race` has this same test against the naive implementation, where it
 * fails: sixteen individually affordable withdrawals all pass their check against a snapshot
 * taken before any of them committed, and the account ends up overdrawn by an amount no
 * single request ever asked for.
 *
 * What changed is not the rule but who decides. `SELECT ... FOR NO KEY UPDATE` on the account
 * row makes the check and the insert one decision per account instead of two statements with
 * a window between them.
 *
 * **Every test here asserts the outcome, not only the aftermath.** The balance being
 * non-negative and the book adding up are both true of a run in which all sixteen requests
 * failed - with a deadlock, with an exhausted retry loop, or with a 500 from a write path that
 * had stopped working altogether. A suite that checked only those would have stayed green
 * through exactly the regression it exists to catch, so the accepted count is bounded by what
 * the money allows - pinned exactly under `row-lock`, capped and required to be non-zero under
 * `serializable` (see `expectAffordableAccepted`) - and every rejection has to be the domain
 * error that means "you cannot afford this", or, under `serializable`, a retry exhausted by
 * genuine contention.
 */

const ROUNDS = 5;
/** €500.00 available, sixteen concurrent requests for €100.00. At most five may succeed. */
const OPENING = 50_000n;
const WITHDRAWAL = 10_000n;
const CONCURRENT = 16;

/** Five. What the opening balance actually pays for, and therefore what must be accepted. */
const AFFORDABLE = Number(OPENING / WITHDRAWAL);

/**
 * Asserts that every rejection is one this strategy is allowed to produce.
 *
 * Under `row-lock` that is `AccountOverdrawnError` and nothing else. Writers block rather than
 * fail, so "there was not enough money" is the only reason left to turn a request down, and a
 * `40P01`, a `40001` or a raw driver error would every one of them be a bug wearing the same
 * costume as a refusal.
 *
 * Under `serializable` it is that *or* a `40001` that ran out of retries, and the difference is
 * the strategy rather than a defect. SSI predicate-locks the account's whole posting range -
 * that is what "every historical prefix" costs - so sixteen writers to one account abort each
 * other repeatedly, and at `maxAttempts` of 5 a substantial share of them exhaust the budget
 * before they ever get far enough to be told they cannot afford it. This is measured, not
 * assumed: see the note in `docs/adr/0004-concurrency-control.md`, which this observation
 * corrects. It is also precisely the caller-visible failure mode the decision to ship
 * `row-lock` was taken to avoid, so asserting it here keeps the alternative honest instead of
 * letting the suite imply the two strategies are interchangeable at the API boundary.
 */
function expectExpectedRejections(
  errors: readonly unknown[],
  strategy: ConcurrencyStrategy,
  context: string,
): void {
  const acceptable = (error: unknown): boolean =>
    error instanceof AccountOverdrawnError ||
    (strategy === 'serializable' && hasSqlState(error, SQLSTATE.SERIALIZATION_FAILURE));

  expect(errors.filter((error) => !acceptable(error)).map(describeError), `${context}: unexpected rejection`).toEqual(
    [],
  );
}

/**
 * Asserts that the right number of withdrawals got through.
 *
 * Under `row-lock` it is exactly the five the money pays for. Writers block rather than fail, so
 * every affordable withdrawal eventually acquires the lock and commits, and any shortfall is the
 * shape every failure mode here takes: a deadlock, a broken write path, affordable requests being
 * refused. That is the assertion this test was written for and it stays exact.
 *
 * Under `serializable` the count is a range, and the reason is measured rather than assumed.
 * Sixteen writers to one account abort each other repeatedly - SSI predicate-locks the account's
 * whole posting range, which is what the historical-prefix rule costs - and at `maxAttempts` of 5
 * a winner can burn its budget on 40001s before it ever commits. Three, four and five accepted
 * were all observed across consecutive runs. Demanding five made this test intermittently red for
 * a strategy that is deliberately not shipped, which is worse than not asserting it.
 *
 * The upper bound is the one that carries the safety property, and it is exact in both modes:
 * more than five accepted means the account went overdrawn. The lower bound only rules out total
 * collapse, since anything above zero is a legitimate outcome of retry exhaustion. The balance
 * assertion at the call site then pins the arithmetic against whatever count came back, so the
 * looser bound here does not buy the implementation any slack.
 */
function expectAffordableAccepted(
  accepted: number,
  strategy: ConcurrencyStrategy,
  context: string,
): void {
  if (strategy === 'row-lock') {
    expect(accepted, `${context} accepted the wrong number of withdrawals`).toBe(AFFORDABLE);
    return;
  }

  expect(accepted, `${context} accepted more than the money pays for`).toBeLessThanOrEqual(
    AFFORDABLE,
  );
  expect(accepted, `${context} accepted nothing at all`).toBeGreaterThan(0);
}

/** An error as a short line, with its SQLSTATE if it has one, so a failure message is readable. */
function describeError(error: unknown): string {
  const state = Object.values(SQLSTATE).find((candidate) => hasSqlState(error, candidate));
  const prefix = state === undefined ? '' : `[${state}] `;

  return prefix + (error instanceof Error ? `${error.name}: ${error.message.split('\n')[0] ?? ''}` : String(error));
}

const STRATEGIES: readonly ConcurrencyStrategy[] = ['row-lock', 'serializable'];

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 20 });
});

afterAll(async () => {
  await pool.end();
});

describe.each(STRATEGIES)('concurrent withdrawals under %s', (strategy) => {
  let service: LedgerService;
  let retries = 0;

  beforeAll(() => {
    retries = 0;
    service = createService(pool, {
      strategy,
      onRetry: () => {
        retries += 1;
      },
    }).service;
  });

  it('never drives a guarded account negative', async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const round_ = `round ${round.toString()}`;
      const book = await fundedBook(pool, service, OPENING);

      const outcome = await fireConcurrently(service, book, CONCURRENT, WITHDRAWAL);

      expectAffordableAccepted(outcome.accepted, strategy, round_);
      expectExpectedRejections(outcome.errors, strategy, round_);

      const balance = await balanceOf(pool, book.bookId, book.cash);

      expect(balance, `${round_} left the account overdrawn`).toBeGreaterThanOrEqual(0n);

      // Whatever won, the arithmetic has to hold exactly: the opening balance less what the
      // winners took. Under `row-lock` that is always zero, since all five win. Asserting the
      // relation rather than the constant keeps the check just as tight under `serializable`,
      // where the number of winners is not fixed - a balance that does not match its own
      // accepted count would mean a posting landed that no request was told about, or one was
      // told about that never landed.
      expect(balance, `${round_} balance does not match its accepted count`).toBe(
        OPENING - BigInt(outcome.accepted) * WITHDRAWAL,
      );
    }
  });

  it('conserves total value regardless of who wins', async () => {
    const book = await fundedBook(pool, service, OPENING);

    const outcome = await fireConcurrently(service, book, CONCURRENT, WITHDRAWAL);

    expectAffordableAccepted(outcome.accepted, strategy, 'value conservation');
    expectExpectedRejections(outcome.errors, strategy, 'value conservation');

    const cash = await balanceOf(pool, book.bookId, book.cash);
    const rent = await balanceOf(pool, book.bookId, book.rent);
    const sales = await balanceOf(pool, book.bookId, book.sales);

    expect(cash + rent + sales).toBe(0n);
  });

  it('retries only under serializable, and actually does', () => {
    // A retry path that never runs is untested code. Sixteen writers to one account under
    // SSI will produce 40001s; under row locks they block instead, and there is nothing to
    // retry.
    if (strategy === 'serializable') expect(retries).toBeGreaterThan(0);
    else expect(retries).toBe(0);
  });
});
