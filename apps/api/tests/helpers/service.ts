import { newId, testClock, type TestClock } from '@ledger/shared';
import type { Pool } from 'pg';
import { DrizzleUnitOfWork, createDatabase, type UnitOfWork } from '../../src/db/client.js';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import { LedgerService } from '../../src/services/ledger.service.js';

/** The instant every service test starts at. Fixed, so `recorded_at` is an assertable value. */
export const START = new Date('2026-03-31T09:00:00.000Z');

export interface ServiceHarness {
  readonly service: LedgerService;
  readonly clock: TestClock;
}

/**
 * The real service, wired to a real database, with only the clock replaced.
 *
 * Nothing else is substituted. A fake repository would test that the service calls methods
 * in an order this file also decides, which proves nothing about deferred triggers,
 * composite foreign keys or what happens when two transactions race for one `external_id`.
 */
export function createService(pool: Pool): ServiceHarness {
  const clock = testClock(START);

  const service = new LedgerService({
    repository: new DrizzleLedgerRepository(),
    unitOfWork: new DrizzleUnitOfWork(createDatabase(pool)),
    clock,
    newId,
  });

  return { service, clock };
}

/**
 * A unit of work that fails if it is used at all.
 *
 * "Validated before hitting the database" is otherwise an untestable claim: a service that
 * opened a transaction, discovered the problem and rolled back would pass every assertion
 * about the error it threw. This turns the claim into something the test can actually
 * observe.
 */
/**
 * A service whose transactions always fail with a given database error.
 *
 * The only way to reach the branches that translate a SQLSTATE the application check was
 * supposed to prevent. Provoking LG001 for real would mean shipping a service with a hole in
 * its zero-sum check, which is the thing being defended against.
 */
export function createServiceWithFailingTransaction(failure: unknown): LedgerService {
  const unitOfWork: UnitOfWork = {
    transaction: () => Promise.reject(failure),
    get executor(): never {
      throw new Error('no executor: this harness never gets as far as a query');
    },
  };

  return new LedgerService({
    repository: new DrizzleLedgerRepository(),
    unitOfWork,
    clock: testClock(START),
    newId,
  });
}

export function createServiceWithoutDatabase(): LedgerService {
  const refuse = (): never => {
    throw new Error('the database was used, but this operation was supposed to fail before that');
  };

  const unitOfWork: UnitOfWork = {
    transaction: refuse,
    get executor() {
      return refuse();
    },
  };

  return new LedgerService({
    repository: new DrizzleLedgerRepository(),
    unitOfWork,
    clock: testClock(START),
    newId,
  });
}
