import { newId, systemClock } from '@ledger/shared';
import type { Pool } from 'pg';
import { argon2idHasher, type PasswordHasher } from './auth/password.js';
import {
  accessTokens,
  refreshTokens,
  type AccessTokens,
  type RefreshTokens,
} from './auth/tokens.js';
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
  readonly passwordHasher: PasswordHasher;
  readonly accessTokens: AccessTokens;
  readonly refreshTokens: RefreshTokens;
  close(): Promise<void>;
}

export function createApplication(config: Config = getConfig()): Application {
  const pool = createPool(config.database.url, config.database.poolMax);
  const db = createDatabase(pool);
  const clock = systemClock;

  const ledger = new LedgerService({
    repository: new DrizzleLedgerRepository(),
    unitOfWork: new DrizzleUnitOfWork(db),
    clock,
    newId,
  });

  return {
    config,
    pool,
    db,
    ledger,

    // The auth primitives are built here for the same reason everything else is: they read
    // configuration, and this is the one module allowed to. The clock goes into the token
    // issuer as well as the ledger service, so expiry is a value a test can move rather than
    // a race against the wall clock.
    passwordHasher: argon2idHasher(config.auth.argon2),
    accessTokens: accessTokens({ config: config.auth, clock, newId }),
    refreshTokens: refreshTokens(config.auth.refreshTokenPepper),

    close: async () => {
      await pool.end();
    },
  };
}
