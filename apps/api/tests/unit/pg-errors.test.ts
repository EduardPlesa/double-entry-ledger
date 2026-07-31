import { describe, expect, it } from 'vitest';
import { SQLSTATE, hasSqlState, isUniqueViolationOn } from '../../src/db/pg-errors.js';

/**
 * Reading a SQLSTATE off an error that has been wrapped.
 *
 * These exist because the original versions checked only the top-level error, and drizzle
 * does not rethrow the driver's error - it throws its own with the original as `cause`. The
 * result was silent: every constraint violation read as an unrecognised failure, so a
 * duplicate email produced a 500 instead of a 409, and the branch translating the database's
 * own zero-sum verdict could never fire.
 *
 * It survived because the tests built their own error objects, which had the shape the code
 * expected rather than the shape the driver produces. An integration test against a real
 * duplicate insert is what found it, and these are what stop it coming back.
 */

/** The shape node-postgres actually throws. */
function driverError(code: string, constraint?: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  });
}

/** The shape drizzle wraps it in. */
function wrapped(cause: Error): Error {
  return new Error('Failed query: insert into "users" ...', { cause });
}

describe('hasSqlState', () => {
  it('reads the state off a bare driver error', () => {
    expect(hasSqlState(driverError(SQLSTATE.ENTRY_UNBALANCED), SQLSTATE.ENTRY_UNBALANCED)).toBe(true);
  });

  it('reads it through a wrapper', () => {
    expect(hasSqlState(wrapped(driverError('LG001')), SQLSTATE.ENTRY_UNBALANCED)).toBe(true);
  });

  it('reads it through several wrappers', () => {
    expect(hasSqlState(wrapped(wrapped(driverError('LG002'))), SQLSTATE.HISTORY_IMMUTABLE)).toBe(true);
  });

  it('says no for a different state, and for things that are not database errors', () => {
    expect(hasSqlState(wrapped(driverError('23505')), SQLSTATE.ENTRY_UNBALANCED)).toBe(false);
    expect(hasSqlState(new Error('just an error'), SQLSTATE.ENTRY_UNBALANCED)).toBe(false);
    expect(hasSqlState(null, SQLSTATE.ENTRY_UNBALANCED)).toBe(false);
    expect(hasSqlState({ code: 'LG001' }, SQLSTATE.ENTRY_UNBALANCED)).toBe(false);
  });

  it('terminates on a cause cycle instead of hanging', () => {
    // Nothing produces this, and an unbounded walk over attacker-adjacent data is not a thing
    // to leave to chance.
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    (first as { cause?: unknown }).cause = second;

    expect(hasSqlState(first, SQLSTATE.ENTRY_UNBALANCED)).toBe(false);
  });
});

describe('isUniqueViolationOn', () => {
  it('matches the state and the constraint name together, through a wrapper', () => {
    const error = wrapped(driverError(SQLSTATE.UNIQUE_VIOLATION, 'users_email_key'));

    expect(isUniqueViolationOn(error, 'users_email_key')).toBe(true);
  });

  it('does not match a unique violation on some other constraint', () => {
    // `entries` has more than one unique constraint. "Some uniqueness rule was broken" is not
    // enough to conclude that a concurrent request won the idempotency race.
    const error = wrapped(driverError(SQLSTATE.UNIQUE_VIOLATION, 'entries_id_book_id_key'));

    expect(isUniqueViolationOn(error, 'entries_book_id_external_id_key')).toBe(false);
  });

  it('does not match a different failure on the right constraint', () => {
    const error = wrapped(driverError(SQLSTATE.FOREIGN_KEY_VIOLATION, 'users_email_key'));

    expect(isUniqueViolationOn(error, 'users_email_key')).toBe(false);
  });
});
