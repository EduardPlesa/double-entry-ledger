/**
 * Domain errors.
 *
 * Deliberately carrying no HTTP status. The service layer knows an entry is unbalanced; it
 * does not know that this is a 422, because it does not know it is being called over HTTP
 * at all. Stage 3 adds exactly one place - the error middleware - that maps `code` to a
 * status and an RFC 9457 problem document. Any other arrangement ends with a status code
 * chosen in three files that disagree.
 *
 * `code` is a stable machine-readable string. Callers, tests and eventually clients branch
 * on it; the message is for humans and is free to change.
 */
/**
 * Every code a domain error can carry.
 *
 * A union rather than a loose string, and the reason is one line in `error-middleware.ts`:
 * the status map is typed `Record<DomainErrorCode, ...>`, so adding an error here without
 * deciding what it means over HTTP fails the build rather than falling through to a 500 on
 * the day it is first thrown. That is the compile-time version of the route meta-test.
 */
export type DomainErrorCode =
  | 'VALIDATION_FAILED'
  | 'ENTRY_UNBALANCED'
  | 'BOOK_NOT_FOUND'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NOT_IN_BOOK'
  | 'ACCOUNT_CLOSED'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_CURSOR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_ALREADY_REVERSED'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'USER_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_IN_FLIGHT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'API_KEY_NOT_PERMITTED';

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Input that does not describe a possible entry at all: wrong shape, wrong types. */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';

  constructor(
    message: string,
    /** Field-level detail, already flattened for a client. */
    readonly details: readonly { path: string; message: string }[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface CurrencyImbalance {
  readonly currency: string;
  /** How far from zero that currency's legs sum. Never zero; balanced currencies are omitted. */
  readonly amountMinor: bigint;
}

/**
 * The invariant, caught in application code.
 *
 * The database catches this too, at COMMIT, via a deferred constraint trigger - and that is
 * the enforcement that actually matters, because it binds every writer including psql. This
 * error exists so the common case fails before a transaction is opened and with a message
 * that names the currency and the amount, rather than as a generic constraint violation
 * after the round trip.
 */
export class UnbalancedEntryError extends DomainError {
  readonly code = 'ENTRY_UNBALANCED';

  constructor(
    /**
     * Empty when the database raised LG001 rather than the application check. In that case
     * the trigger knows which currency is off and this process does not, because the whole
     * point of the deferred check is that it sees the committed set rather than the request.
     */
    readonly imbalances: readonly CurrencyImbalance[],
    options?: { cause?: unknown },
  ) {
    super(
      imbalances.length === 0
        ? 'entry is unbalanced: rejected by the database at COMMIT'
        : `entry is unbalanced: ${imbalances
            .map((i) => `${i.currency} legs sum to ${i.amountMinor.toString()}`)
            .join(', ')}`,
      options,
    );
  }
}

export class BookNotFoundError extends DomainError {
  readonly code = 'BOOK_NOT_FOUND';

  constructor(readonly bookId: string) {
    super(`book ${bookId} does not exist`);
  }
}

export class AccountNotFoundError extends DomainError {
  readonly code = 'ACCOUNT_NOT_FOUND';

  constructor(readonly accountIds: readonly string[]) {
    super(
      accountIds.length === 1
        ? `account ${accountIds[0] ?? ''} does not exist`
        : `accounts do not exist: ${accountIds.join(', ')}`,
    );
  }
}

/**
 * An account that exists, but not in this book. Distinct from "does not exist" on purpose:
 * the caller is authorised for one book, and confirming the existence of an account in
 * another would leak across the boundary stage 3 enforces with row-level security.
 * The message is deliberately as uninformative as the not-found one.
 */
export class AccountNotInBookError extends DomainError {
  readonly code = 'ACCOUNT_NOT_IN_BOOK';

  constructor(
    readonly accountId: string,
    readonly bookId: string,
  ) {
    super(`account ${accountId} does not exist in book ${bookId}`);
  }
}

export class AccountClosedError extends DomainError {
  readonly code = 'ACCOUNT_CLOSED';

  constructor(
    readonly accountId: string,
    readonly closedAt: Date,
  ) {
    super(`account ${accountId} was closed at ${closedAt.toISOString()} and cannot be posted to`);
  }
}

/** A leg denominated in a currency its account does not hold. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly accountId: string,
    readonly accountCurrency: string,
    readonly legCurrency: string,
  ) {
    super(`account ${accountId} holds ${accountCurrency}, but the leg is denominated in ${legCurrency}`);
  }
}

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';

  constructor(readonly cursor: string) {
    super(`cursor ${JSON.stringify(cursor)} is not a cursor this endpoint issued`);
  }
}

/**
 * No usable credential: absent, malformed, expired, revoked, or signed by something else.
 *
 * Deliberately one error for all of those. The `reason` is for the log, never for the
 * response - telling a caller that their token was well-formed but expired, rather than
 * simply invalid, is free information about how close they got.
 */
export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';

  constructor(readonly reason: string) {
    super('authentication is required');
  }
}

/**
 * Authenticated, a member of this book, and the role does not carry the permission.
 *
 * Not the error for "not a member of this book" - that is a `BookNotFoundError`, because a
 * 403 to a non-member turns book membership into something anyone holding an id can
 * enumerate.
 */
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';

  constructor(
    readonly permission: string,
    readonly role: string,
  ) {
    super(`the ${role} role does not carry ${permission}`);
  }
}

/**
 * An operation a machine client cannot perform, however privileged its key.
 *
 * Creating a book is the case that exists: an API key is scoped to exactly one book, so a key
 * creating a second one would either escape its own scope or produce a book it cannot reach.
 * Neither is a permission question, which is why this is not a ForbiddenError - no role would
 * make it possible.
 */
export class ApiKeyNotPermittedError extends DomainError {
  readonly code = 'API_KEY_NOT_PERMITTED';

  constructor(readonly operation: string) {
    super(`${operation} requires a user session; an API key is scoped to one book`);
  }
}

export class EntryNotFoundError extends DomainError {
  readonly code = 'ENTRY_NOT_FOUND';

  constructor(readonly entryId: string) {
    super(`entry ${entryId} does not exist`);
  }
}

/**
 * An entry may be reversed at most once. Stage 4 makes this a partial unique index on
 * `reversal_of`; until then the service checks it, and the error is the same either way.
 */
export class EntryAlreadyReversedError extends DomainError {
  readonly code = 'ENTRY_ALREADY_REVERSED';

  constructor(
    readonly entryId: string,
    readonly reversalId: string,
  ) {
    super(`entry ${entryId} was already reversed by entry ${reversalId}`);
  }
}

export class EmailAlreadyRegisteredError extends DomainError {
  readonly code = 'EMAIL_ALREADY_REGISTERED';

  constructor(readonly email: string) {
    super(`${email} is already registered`);
  }
}

export class UserNotFoundError extends DomainError {
  readonly code = 'USER_NOT_FOUND';

  constructor(readonly userId: string) {
    super(`user ${userId} does not exist`);
  }
}

/** A request with this idempotency key is still running. Retry when it has finished. */
export class IdempotencyKeyInFlightError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_IN_FLIGHT';

  constructor(readonly key: string) {
    super(`a request with idempotency key ${JSON.stringify(key)} is still in flight`);
  }
}

/**
 * The same idempotency key, a different request body.
 *
 * Replaying the first response here would hide a client bug behind a plausible answer: the
 * caller believes they sent the second request and would be handed the result of the first.
 */
export class IdempotencyKeyReusedError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor(readonly key: string) {
    super(`idempotency key ${JSON.stringify(key)} was already used for a different request`);
  }
}
