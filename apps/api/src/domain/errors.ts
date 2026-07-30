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
export abstract class DomainError extends Error {
  abstract readonly code: string;

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
