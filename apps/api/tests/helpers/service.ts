import { newId, testClock, type TestClock } from '@ledger/shared';
import type { Pool } from 'pg';
import {
  DrizzleUnitOfWork,
  createDatabase,
  type ConcurrencyStrategy,
  type Executor,
  type UnitOfWork,
} from '../../src/db/client.js';
import {
  DrizzleLedgerRepository,
  type EntryRecord,
} from '../../src/repositories/ledger.repository.js';
import { LedgerService } from '../../src/services/ledger.service.js';

/** The instant every service test starts at. Fixed, so `recorded_at` is an assertable value. */
export const START = new Date('2026-03-31T09:00:00.000Z');

export interface ServiceHarness {
  readonly service: LedgerService;
  readonly clock: TestClock;
}

export interface ServiceOptions {
  readonly strategy?: ConcurrencyStrategy;
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

/**
 * The real service, wired to a real database, with only the clock replaced.
 *
 * Nothing else is substituted. A fake repository would test that the service calls methods
 * in an order this file also decides, which proves nothing about deferred triggers,
 * composite foreign keys or what happens when two transactions race for one `external_id`.
 */
export function createService(pool: Pool, options: ServiceOptions = {}): ServiceHarness {
  const clock = testClock(START);

  const service = new LedgerService({
    repository: new DrizzleLedgerRepository(),
    unitOfWork: new DrizzleUnitOfWork(createDatabase(pool), {
      strategy: options.strategy ?? 'row-lock',
      ...(options.onRetry !== undefined ? { onRetry: options.onRetry } : {}),
    }),
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
    strategy: 'row-lock' as const,
    transaction: () => Promise.reject(failure),
    transactionInBook: () => Promise.reject(failure),
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

/**
 * A service whose idempotency read misses once, the way a racing caller's does.
 *
 * Losing a race for one `external_id` is defined entirely by what the loser saw: it read
 * `entries` before the winner's row was committed, found nothing, and learned otherwise from
 * the unique index. That first read is the only thing this substitutes, and only once - which
 * is once per `postEntry` call, because the recovery branch's lookup is the second and is
 * answered truthfully. Everything else is real: the insert collides with the real index, the
 * recovery opens its own real transaction, and the reversal it reports comes from a real
 * lookup.
 *
 * Without this, a race whose winner committed before the losers started is not a race at all.
 * Every caller's read finds the entry and returns through the in-transaction replay branch,
 * and the recovery below it never runs - so the reversal it reports would go untested.
 */
export function createServiceBlindToItsFirstReplayRead(pool: Pool): LedgerService {
  return new LedgerService({
    repository: new ReplayBlindRepository(),
    unitOfWork: new DrizzleUnitOfWork(createDatabase(pool), { strategy: 'row-lock' }),
    clock: testClock(START),
    newId,
  });
}

class ReplayBlindRepository extends DrizzleLedgerRepository {
  #blind = true;

  override async findEntryByExternalId(
    executor: Executor,
    bookId: string,
    externalId: string,
  ): Promise<EntryRecord | null> {
    if (this.#blind) {
      this.#blind = false;
      return null;
    }

    return super.findEntryByExternalId(executor, bookId, externalId);
  }
}

export function createServiceWithoutDatabase(): LedgerService {
  const refuse = (): never => {
    throw new Error('the database was used, but this operation was supposed to fail before that');
  };

  const unitOfWork: UnitOfWork = {
    strategy: 'row-lock' as const,
    transaction: refuse,
    transactionInBook: refuse,
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
