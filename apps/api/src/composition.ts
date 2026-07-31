import { newId, systemClock, type Clock } from '@ledger/shared';
import type { Express } from 'express';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { argon2idHasher } from './auth/password.js';
import { accessTokens, refreshTokens } from './auth/tokens.js';
import { type Config, getConfig } from './config.js';
import { DrizzleUnitOfWork, createDatabase, createPool, type Database } from './db/client.js';
import { createApp } from './http/app.js';
import { createLogger } from './http/logger.js';
import { DrizzleAuthRepository } from './repositories/auth.repository.js';
import { DrizzleLedgerRepository } from './repositories/ledger.repository.js';
import { allRoutes, guardsFor } from './routes/index.js';
import { AuthService } from './services/auth.service.js';
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
  readonly logger: Logger;
  readonly ledger: LedgerService;
  readonly auth: AuthService;
  readonly app: Express;
  close(): Promise<void>;
}

/**
 * Overrides, for tests.
 *
 * Only two things are ever worth substituting here, and both are things the process cannot
 * control: what time it is, and how expensive hashing should be. Everything else - the
 * database, the repositories, the services - stays real, because a test against a fake
 * repository tests the order this file calls methods in.
 */
export interface ApplicationOverrides {
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export function createApplication(
  config: Config = getConfig(),
  overrides: ApplicationOverrides = {},
): Application {
  const pool = createPool(config.database.url, config.database.poolMax);
  const db = createDatabase(pool);
  const unitOfWork = new DrizzleUnitOfWork(db);
  const clock = overrides.clock ?? systemClock;
  const logger = overrides.logger ?? createLogger(config);

  const ledger = new LedgerService({
    repository: new DrizzleLedgerRepository(),
    unitOfWork,
    clock,
    newId,
  });

  // The auth primitives are built here for the same reason everything else is: they read
  // configuration, and this is the one module allowed to. The clock goes into the token
  // issuer as well as the ledger service, so expiry is a value a test can move rather than a
  // race against the wall clock.
  const auth = new AuthService({
    repository: new DrizzleAuthRepository(),
    unitOfWork,
    passwordHasher: argon2idHasher(config.auth.argon2),
    accessTokens: accessTokens({ config: config.auth, clock, newId }),
    refreshTokens: refreshTokens(config.auth.refreshTokenPepper),
    clock,
    newId,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
  });

  const app = createApp({
    definitions: allRoutes({ auth }),
    guards: guardsFor,
    logger,
  });

  return {
    config,
    pool,
    db,
    logger,
    ledger,
    auth,
    app,

    close: async () => {
      await pool.end();
    },
  };
}
