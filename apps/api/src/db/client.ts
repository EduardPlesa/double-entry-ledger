import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
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
   * A transaction with `app.current_book_id` established, which is what migration 0006's
   * policies are keyed on. Every statement touching accounts, entries or postings has to run
   * inside one of these; outside, the policies see no book and return no rows.
   *
   * The caller is responsible for having decided that this book is allowed - the setting is
   * how an authorisation decision already made is communicated to the database, not where it
   * gets made.
   */
  transactionInBook<T>(bookId: string, work: (tx: Executor) => Promise<T>): Promise<T>;

  /**
   * A handle for statements that genuinely do not need a transaction: a single SELECT is
   * already atomic. Reaching for this instead of wrapping one statement in BEGIN/COMMIT
   * saves two round trips per read on the hottest paths in the system.
   *
   * Since migration 0006 this is only good for the tables with no policy on them - users,
   * memberships, refresh tokens, and the book lookup functions. A book-scoped read through
   * this handle does not fail; it quietly returns nothing, which is worse.
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

  /**
   * `SET LOCAL` accepts no bind parameter - it is not a statement Postgres will plan with
   * one - so this is `set_config(..., is_local => true)`, which is the same thing and takes
   * the book id as a parameter instead of concatenating it into SQL text.
   *
   * Transaction-local, hence `is_local => true`. A session-level setting on a pooled
   * connection would outlive the request that set it and still be in place for whichever
   * request borrowed the connection next, which is a cross-book data leak whose cause looks
   * entirely innocent at the call site.
   */
  async transactionInBook<T>(bookId: string, work: (tx: Executor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_book_id', ${bookId}, true)`);
      return work(tx);
    });
  }
}

export function createPool(url: string, max: number): Pool {
  return new Pool({ connectionString: url, max });
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}
