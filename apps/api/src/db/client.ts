import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Anything a statement can run against: the pool-backed database, or a transaction handle.
 * Written as their common supertype rather than as a union, because a union of two types
 * with generic methods is a type TypeScript will not let you call a method on.
 *
 * Repositories take one of these, so the same method works inside a transaction and
 * outside it, and the decision about transaction boundaries belongs to the service - where
 * it can be reasoned about - rather than being baked into data access.
 */
export type Executor = PgDatabase<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Transaction boundaries as a dependency.
 *
 * The service says "these statements are one atomic unit" without knowing what a
 * transaction is made of, which keeps a test free to hand it a fake. This is the seam
 * stage 3's row-level security uses too: the `SET LOCAL app.current_book_id` that policy
 * depends on has to happen inside the same transaction as the statements it governs, and
 * that is a property of this wrapper, not of every call site.
 */
export interface UnitOfWork {
  transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T>;

  /**
   * A handle for statements that genuinely do not need a transaction: a single SELECT is
   * already atomic. Reaching for this instead of wrapping one statement in BEGIN/COMMIT
   * saves two round trips per read on the hottest paths in the system.
   */
  readonly executor: Executor;
}

export class DrizzleUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Database) {}

  get executor(): Executor {
    return this.db;
  }

  /**
   * READ COMMITTED, which is the Postgres default and is deliberately not overridden here.
   * Stage 4 introduces a rule - an account type that may not go negative - that READ
   * COMMITTED cannot enforce, demonstrates the failure with a concurrent test, and only
   * then decides between row locks and SERIALIZABLE. Choosing an isolation level before
   * there is a constraint that needs one is how projects end up with SERIALIZABLE
   * everywhere and no idea which query needed it.
   */
  async transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => work(tx));
  }
}

export function createPool(url: string, max: number): Pool {
  return new Pool({ connectionString: url, max });
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}
