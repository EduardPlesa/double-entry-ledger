import { newId, systemClock } from '@ledger/shared';
import type { Pool } from 'pg';
import { type Config, getConfig } from './config.js';
import { DrizzleUnitOfWork, createDatabase, createPool, type Database } from './db/client.js';
import { DrizzleLedgerRepository } from './repositories/ledger.repository.js';
import { LedgerService } from './services/ledger.service.js';

/**
 * The composition root: the one place where interfaces meet implementations.
 *
 * Every other module names what it needs and receives it. That is why the service tests can
 * run against a throwaway Postgres with a clock that does not move, and why swapping the
 * system clock for a stopped one is a change to this file and nowhere else.
 *
 * `getConfig()` is called here and only here, so an invalid environment stops the process at
 * boot rather than at the first request that happens to need a connection string.
 */
export interface Application {
  readonly config: Config;
  readonly pool: Pool;
  readonly db: Database;
  readonly ledger: LedgerService;
  close(): Promise<void>;
}

export function createApplication(config: Config = getConfig()): Application {
  const pool = createPool(config.database.url, config.database.poolMax);
  const db = createDatabase(pool);

  const ledger = new LedgerService({
    repository: new DrizzleLedgerRepository(),
    unitOfWork: new DrizzleUnitOfWork(db),
    clock: systemClock,
    newId,
  });

  return {
    config,
    pool,
    db,
    ledger,
    close: async () => {
      await pool.end();
    },
  };
}
