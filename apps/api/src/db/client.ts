import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { SQLSTATE, hasSqlState } from './pg-errors.js';
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
 * How the overdraft rule is kept true when two writers meet.
 *
 * `row-lock`: the service takes `SELECT ... FOR NO KEY UPDATE` on the accounts at risk and
 * this wrapper does nothing special. Writers block. The mode is the weaker one deliberately -
 * `lockAccounts` explains why `FOR UPDATE` deadlocks against a posting's own foreign key check.
 *
 * `serializable`: no explicit locks; Postgres detects the conflict and aborts one of the
 * transactions with 40001, which this wrapper retries. Writers abort and try again.
 *
 * Both are correct. They are different bets about which is cheaper, and the ADR has numbers.
 */
export type ConcurrencyStrategy = 'row-lock' | 'serializable';

export interface UnitOfWorkOptions {
  readonly strategy?: ConcurrencyStrategy;
  /** Total attempts, not retries. Exceeding it rethrows the last 40001. */
  readonly maxAttempts?: number;
  /** Called before each retry. Exists so a test can assert the retry path actually ran. */
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

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

  /** Which concurrency strategy is in force. The service skips its row locks under `serializable`. */
  readonly strategy: ConcurrencyStrategy;
}

export class DrizzleUnitOfWork implements UnitOfWork {
  readonly strategy: ConcurrencyStrategy;
  private readonly maxAttempts: number;
  private readonly onRetry: ((attempt: number, error: unknown) => void) | undefined;

  constructor(
    private readonly db: Database,
    options: UnitOfWorkOptions = {},
  ) {
    this.strategy = options.strategy ?? 'row-lock';
    this.maxAttempts = options.maxAttempts ?? 5;
    this.onRetry = options.onRetry;
  }

  get executor(): Executor {
    return this.db;
  }

  /**
   * READ COMMITTED by default, which is the Postgres default and is deliberately not
   * overridden: stage 4 demonstrated that it cannot enforce the overdraft rule on its own,
   * and then fixed that with locks rather than by raising the isolation level everywhere.
   * Under the `serializable` strategy this becomes SERIALIZABLE and 40001 is retried.
   */
  async transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T> {
    return this.withRetry(() => this.db.transaction(async (tx) => work(tx), this.options()));
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
   *
   * The whole body is what gets retried, `set_config` included: a retry is a fresh
   * transaction, and a fresh transaction has no book context until it sets one.
   */
  async transactionInBook<T>(bookId: string, work: (tx: Executor) => Promise<T>): Promise<T> {
    return this.withRetry(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.current_book_id', ${bookId}, true)`);
        return work(tx);
      }, this.options()),
    );
  }

  private options(): { isolationLevel?: 'serializable' } {
    return this.strategy === 'serializable' ? { isolationLevel: 'serializable' } : {};
  }

  /**
   * Retries a transaction that Postgres refused to serialize.
   *
   * Only 40001, and only under the serializable strategy. Not 40P01: a deadlock means two
   * transactions took locks in incompatible orders, which is a bug in the lock ordering
   * rather than bad luck, and retrying it would hide the bug behind a slow success.
   *
   * The caller's `work` runs again from the top, so anything it must not repeat has to be
   * computed outside it. `postEntry` does exactly that with the entry id and `recordedAt`:
   * a retried post is the same entry, not a new one.
   */
  private async withRetry<T>(run: () => Promise<T>): Promise<T> {
    if (this.strategy !== 'serializable') return run();

    let last: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (!hasSqlState(error, SQLSTATE.SERIALIZATION_FAILURE)) throw error;

        last = error;
        this.onRetry?.(attempt, error);
      }
    }

    // `last` is only unset if the loop never ran, which needs `maxAttempts` below 1. Throwing
    // it bare would then throw `undefined` - an unhandled rejection with no message, no stack
    // and no SQLSTATE, from a misconfiguration that deserves to name itself.
    throw (
      last ??
      new Error(
        `withRetry ran no attempts: maxAttempts is ${this.maxAttempts.toString()}, which must be at least 1`,
      )
    );
  }
}

export function createPool(url: string, max: number): Pool {
  return new Pool({ connectionString: url, max });
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}
