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

export function hasSqlState(error: unknown, sqlState: string): boolean {
  return isDatabaseError(error) && error.code === sqlState;
}

/**
 * A unique violation on one named constraint.
 *
 * The name matters: `entries` has more than one unique constraint, and "some uniqueness
 * rule was broken" is not enough to conclude that a concurrent request won the idempotency
 * race. Anything else has to keep propagating.
 */
export function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  return (
    isDatabaseError(error) && error.code === SQLSTATE.UNIQUE_VIOLATION && error.constraint === constraint
  );
}
