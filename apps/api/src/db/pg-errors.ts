/**
 * Reading the database's own answers.
 *
 * Every check the database makes has a SQLSTATE, and the ledger's three invariants have
 * SQLSTATEs of their own (migration 0003). Branching on those rather than on message text
 * is what makes "the constraint fired" a fact the application can act on instead of a
 * string it has to hope nobody rewords.
 */

export const SQLSTATE = {
  /** Postgres: unique constraint or index violated. */
  UNIQUE_VIOLATION: '23505',
  /** Postgres: foreign key violated. */
  FOREIGN_KEY_VIOLATION: '23503',
  /** Ledger: an entry's postings do not sum to zero. Raised at COMMIT. */
  ENTRY_UNBALANCED: 'LG001',
  /** Ledger: an attempt to UPDATE, DELETE or TRUNCATE history. */
  HISTORY_IMMUTABLE: 'LG002',
  /** Ledger: an entry with no postings. Raised at COMMIT. */
  ENTRY_WITHOUT_POSTINGS: 'LG003',
  /** Ledger: a guarded account would be left negative. Raised at COMMIT. */
  ACCOUNT_OVERDRAWN: 'LG004',
  /** Postgres: could not serialize access. The retryable one. */
  SERIALIZATION_FAILURE: '40001',
  /** Postgres: deadlock detected. Deliberately NOT retried - see lockAccounts. */
  DEADLOCK_DETECTED: '40P01',
} as const;

/** The subset of node-postgres' error we actually read. */
export interface DatabaseError extends Error {
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
}

export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}

/**
 * How deep to follow `cause`. One wrapper is what drizzle adds; the rest is slack for a
 * future one, bounded so a cycle cannot hang the process.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * The driver's error, wherever it ended up in the chain.
 *
 * Drizzle does not rethrow node-postgres' error - it throws its own, with the original as
 * `cause` and a message containing the failed SQL. So a check against the top-level error
 * finds no SQLSTATE at all and every constraint violation reads as an unrecognised failure:
 * a 500 instead of a 409, and a zero-sum violation from the database translated into nothing.
 *
 * That is a failure mode with no symptom in a unit test, because a test that constructs
 * `Object.assign(new Error(), { code: 'LG001' })` is testing the shape it just built rather
 * than the shape the driver produces. It took an integration test against a real duplicate
 * insert to see it.
 */
function findDatabaseError(error: unknown): DatabaseError | null {
  let current = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (isDatabaseError(current)) return current;
    if (!(current instanceof Error) || current.cause === undefined) return null;
    current = current.cause;
  }

  return null;
}

export function hasSqlState(error: unknown, sqlState: string): boolean {
  return findDatabaseError(error)?.code === sqlState;
}

/**
 * A unique violation on one named constraint.
 *
 * The name matters: `entries` has more than one unique constraint, and "some uniqueness
 * rule was broken" is not enough to conclude that a concurrent request won the idempotency
 * race. Anything else has to keep propagating.
 */
export function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  const databaseError = findDatabaseError(error);
  return (
    databaseError?.code === SQLSTATE.UNIQUE_VIOLATION && databaseError.constraint === constraint
  );
}
