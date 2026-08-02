import { formatMoney, money } from '@ledger/shared';
import type { ErrorRequestHandler } from 'express';
import { AccountOverdrawnError, DomainError, ValidationError, type DomainErrorCode } from '../domain/errors.js';
import { PROBLEM_CONTENT_TYPE, problem, type ProblemDetail } from './problem.js';
import { requestIdOf } from './request-id.js';

/**
 * The one place an HTTP status code is chosen.
 *
 * Domain errors carry no status - `domain/errors.ts` argues that at length - so this is
 * where "an entry is unbalanced" becomes 422. Keeping the mapping in a table rather than
 * spread across handlers is what makes it possible to answer "what does this API return
 * when X" by reading one screen, and what stops two routes disagreeing about the same
 * failure.
 *
 * The table is typed `Record<DomainErrorCode, ...>`, so adding a domain error without
 * deciding what it means over HTTP is a compile error rather than a 500 discovered in
 * production.
 */

interface Mapping {
  readonly status: number;
  readonly title: string;
}

const STATUS: Record<DomainErrorCode, Mapping> = {
  // 400: the request does not parse as the thing it claims to be. Malformed, not impossible.
  VALIDATION_FAILED: { status: 400, title: 'Invalid request' },
  INVALID_CURSOR: { status: 400, title: 'Invalid cursor' },

  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },

  // 403 is only ever "you are a member of this book and your role is not enough". Not being
  // a member at all produces a 404 below, deliberately.
  FORBIDDEN: { status: 403, title: 'Insufficient permissions' },
  API_KEY_NOT_PERMITTED: { status: 403, title: 'Not available to API keys' },

  // 404, including for things that exist in another book. Answering more precisely would
  // confirm the existence of rows the caller is not authorised to know about.
  BOOK_NOT_FOUND: { status: 404, title: 'Book not found' },
  ACCOUNT_NOT_FOUND: { status: 404, title: 'Account not found' },
  ACCOUNT_NOT_IN_BOOK: { status: 404, title: 'Account not found' },
  ENTRY_NOT_FOUND: { status: 404, title: 'Entry not found' },
  USER_NOT_FOUND: { status: 404, title: 'User not found' },

  // 409: the request is well-formed and would conflict with the state of something that
  // already exists. Retrying the identical request will not help until that state changes.
  ENTRY_ALREADY_REVERSED: { status: 409, title: 'Entry already reversed' },
  EMAIL_ALREADY_REGISTERED: { status: 409, title: 'Email already registered' },
  IDEMPOTENCY_KEY_IN_FLIGHT: { status: 409, title: 'Request already in flight' },

  // 422: the request parses and every field is the right type, and what it describes cannot
  // be done. This is the distinction the stage brief asks for, and it is a real one - a
  // client can fix a 400 by correcting its serialisation and can only fix a 422 by asking
  // for something different.
  ENTRY_UNBALANCED: { status: 422, title: 'Entry is unbalanced' },
  ACCOUNT_CLOSED: { status: 422, title: 'Account is closed' },
  CURRENCY_MISMATCH: { status: 422, title: 'Currency mismatch' },
  IDEMPOTENCY_KEY_REUSED: { status: 422, title: 'Idempotency key reused' },
  ACCOUNT_OVERDRAWN: { status: 422, title: 'Account would be overdrawn' },
};

export interface ErrorMiddlewareOptions {
  /**
   * Whether to include the underlying message of an unrecognised error in the response.
   *
   * False everywhere but a test. An exception nobody anticipated may carry a connection
   * string, a row, or a fragment of SQL, and a 500 is exactly the moment when the caller is
   * least entitled to any of it.
   */
  readonly exposeInternalErrors: boolean;
}

export function errorMiddleware(options: ErrorMiddlewareOptions): ErrorRequestHandler {
  return (error, request, response, next) => {
    // Express's own contract: if the response has already begun, the only correct thing left
    // to do is destroy the socket, and Express's default handler does that properly.
    if (response.headersSent) {
      next(error);
      return;
    }

    const requestId = requestIdOf(response);
    const instance = request.originalUrl;

    if (error instanceof DomainError) {
      const { status, title } = STATUS[error.code];

      response
        .status(status)
        .type(PROBLEM_CONTENT_TYPE)
        .json(
          problem({
            status,
            title,
            detail: error.message,
            code: error.code,
            instance,
            requestId,
            errors: error instanceof ValidationError ? toProblemDetails(error) : undefined,
            extensions: extensionsOf(error),
          }),
        );
      return;
    }

    // A body that is not JSON at all never reaches a handler, so this is the only place it
    // can be answered. Left to fall through, it would be a 500 for what is unambiguously a
    // client mistake - and the one error where the client most needs to be told it is theirs.
    if (isBodyParseFailure(error)) {
      response
        .status(400)
        .type(PROBLEM_CONTENT_TYPE)
        .json(
          problem({
            status: 400,
            title: 'Invalid request',
            detail: `the request body could not be parsed as JSON: ${error.message}`,
            code: 'VALIDATION_FAILED',
            instance,
            requestId,
          }),
        );
      return;
    }

    // Anything else is a bug, and is logged as one. `request.log` is pino-http's child
    // logger, so the entry already carries the request id and the route.
    request.log.error({ err: error }, 'unhandled error');

    response
      .status(500)
      .type(PROBLEM_CONTENT_TYPE)
      .json(
        problem({
          status: 500,
          title: 'Internal server error',
          detail: options.exposeInternalErrors
            ? `${describe(error)} (exposed because exposeInternalErrors is on)`
            : 'The request could not be completed. Quote the request id when reporting this.',
          code: 'INTERNAL_ERROR',
          instance,
          requestId,
        }),
      );
  };
}

function toProblemDetails(error: ValidationError): readonly ProblemDetail[] {
  return error.details.map((detail) => ({ path: detail.path, message: detail.message }));
}

/**
 * Error-specific members of the problem document.
 *
 * Only the overdraft has any, and it needs them: "how short is it" is the one question a
 * client asks next, and making them parse it out of `detail` would be making them parse
 * English. The amount goes out as a decimal string like every other amount at this
 * boundary - a JSON number would be a double.
 *
 * `accountId` is omitted rather than sent empty when the database raised LG004 and this
 * process never learned which account went short. A member that is absent says "not known";
 * `accountId: ""` says "the account whose id is the empty string", which is a claim, and a
 * false one. The remaining members are already null in that case for the same reason.
 */
function extensionsOf(error: DomainError): Readonly<Record<string, unknown>> | undefined {
  if (!(error instanceof AccountOverdrawnError)) return undefined;

  return {
    ...(error.accountId === null ? {} : { accountId: error.accountId }),
    shortfall:
      error.shortfall === null
        ? null
        : formatMoney(money(error.shortfall.amountMinor, error.shortfall.currency)),
    currency: error.shortfall?.currency ?? null,
    occurredAt: error.occurredAt?.toISOString() ?? null,
  };
}

/**
 * body-parser's own failures: malformed JSON, a body past the size limit, an unsupported
 * charset. It marks them with a `type` and a `status`, which is the only reliable way to
 * tell them from a SyntaxError thrown by application code somewhere deeper.
 */
function isBodyParseFailure(error: unknown): error is Error & { type: string; status: number } {
  if (!(error instanceof Error)) return false;

  const { type, status } = error as unknown as { type?: unknown; status?: unknown };
  return typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
