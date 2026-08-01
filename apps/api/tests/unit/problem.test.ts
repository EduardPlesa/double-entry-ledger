import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  AccountClosedError,
  AccountOverdrawnError,
  BookNotFoundError,
  EntryAlreadyReversedError,
  ForbiddenError,
  IdempotencyKeyInFlightError,
  InvalidCursorError,
  UnauthenticatedError,
  UnbalancedEntryError,
  ValidationError,
} from '../../src/domain/errors.js';
import { PROBLEM_CONTENT_TYPE, problem } from '../../src/http/problem.js';
import { createTestApp, route } from '../helpers/http.js';

/**
 * The error pipeline, end to end through a real Express app.
 *
 * Through supertest rather than by calling the middleware directly, because the questions
 * worth asking are about the response - the status line, the content type, the shape of the
 * body - and a unit test of the middleware would assert about arguments passed to a fake
 * `res.json` instead.
 */

/** An app whose one route throws whatever it is handed. */
function appThrowing(error: unknown, options: { exposeInternalErrors?: boolean } = {}) {
  return createTestApp({
    definitions: [
      route({
        method: 'post',
        path: '/boom',
        handler: () => {
          throw error;
        },
      }),
    ],
    ...options,
  });
}

describe('problem documents', () => {
  it('are served as application/problem+json, not application/json', async () => {
    // The content type is how a client knows it can parse the body as a problem document
    // without guessing from the status code.
    const response = await request(appThrowing(new BookNotFoundError('book-1'))).post('/boom');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  });

  it('carry a type URI, a title, the status, the code and the request id', async () => {
    const response = await request(appThrowing(new BookNotFoundError('book-1'))).post('/boom');

    expect(response.body).toMatchObject({
      type: 'https://ledger.local/problems/book-not-found',
      title: 'Book not found',
      status: 404,
      code: 'BOOK_NOT_FOUND',
      instance: '/boom',
    });
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.detail).toContain('book-1');
  });

  it('echo the request id that is also in the header', async () => {
    // The two must be the same string or the id is useless: a user reads one off a toast and
    // an operator greps for the other.
    const response = await request(appThrowing(new BookNotFoundError('book-1'))).post('/boom');

    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('include field-level detail for a validation failure, and not otherwise', async () => {
    const withDetail = await request(
      appThrowing(
        new ValidationError('invalid entry', [{ path: 'legs.0.amount', message: 'must not be zero' }]),
      ),
    ).post('/boom');

    expect(withDetail.status).toBe(400);
    expect(withDetail.body.errors).toEqual([{ path: 'legs.0.amount', message: 'must not be zero' }]);

    const withoutDetail = await request(appThrowing(new BookNotFoundError('book-1'))).post('/boom');
    expect(withoutDetail.body).not.toHaveProperty('errors');
  });
});

describe('extension members', () => {
  // `problem()` itself, not the pipeline: RFC 9457 extension members are a general
  // mechanism - the overdraft is only the first error to use it - so this is about the
  // merge, not about any one domain error's shape.
  it('are merged into the document alongside the core RFC 9457 fields', () => {
    const document = problem({
      status: 422,
      title: 'Account would be overdrawn',
      detail: 'the account would go negative',
      code: 'ACCOUNT_OVERDRAWN',
      instance: '/boom',
      requestId: 'request-1',
      extensions: { accountId: 'acct-1', shortfall: '-2.50' },
    });

    expect(document).toMatchObject({
      type: 'https://ledger.local/problems/account-overdrawn',
      title: 'Account would be overdrawn',
      status: 422,
      detail: 'the account would go negative',
      code: 'ACCOUNT_OVERDRAWN',
      instance: '/boom',
      requestId: 'request-1',
      accountId: 'acct-1',
      shortfall: '-2.50',
    });
  });

  it('add nothing to the document when there are none', () => {
    const document = problem({
      status: 404,
      title: 'Book not found',
      detail: 'no such book',
      code: 'BOOK_NOT_FOUND',
      instance: '/boom',
      requestId: 'request-1',
    });

    expect(document).not.toHaveProperty('accountId');
    expect(document).not.toHaveProperty('shortfall');
  });
});

describe('the status map', () => {
  it('answers 400 for a request that does not parse and 422 for one that cannot be done', async () => {
    // The distinction the stage brief asks for, and a real one: a 400 is fixable by
    // correcting the serialisation, a 422 only by asking for something different.
    const malformed = await request(appThrowing(new ValidationError('nope'))).post('/boom');
    const impossible = await request(
      appThrowing(new UnbalancedEntryError([{ currency: 'EUR', amountMinor: 500n }])),
    ).post('/boom');

    expect(malformed.status).toBe(400);
    expect(impossible.status).toBe(422);
    expect(impossible.body.detail).toContain('EUR legs sum to 500');
  });

  it('answers 401 for no credential and 403 only for an insufficient role', async () => {
    const unauthenticated = await request(appThrowing(new UnauthenticatedError('token expired'))).post('/boom');
    const forbidden = await request(appThrowing(new ForbiddenError('period:close', 'accountant'))).post('/boom');

    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
  });

  it('never says why authentication failed', async () => {
    // Expired, malformed, wrong signature and revoked are one answer to the caller. Which
    // one they achieved is information about how close they got.
    const response = await request(appThrowing(new UnauthenticatedError('signature verification failed'))).post(
      '/boom',
    );

    expect(response.body.detail).toBe('authentication is required');
    expect(JSON.stringify(response.body)).not.toContain('signature');
  });

  it('answers 409 for a conflict with something that already exists', async () => {
    const reversed = await request(appThrowing(new EntryAlreadyReversedError('e-1', 'e-2'))).post('/boom');
    const inFlight = await request(appThrowing(new IdempotencyKeyInFlightError('key-1'))).post('/boom');

    expect(reversed.status).toBe(409);
    expect(inFlight.status).toBe(409);
  });

  it('answers 422 for a closed account and 400 for a cursor it did not issue', async () => {
    const closed = await request(
      appThrowing(new AccountClosedError('acct-1', new Date('2026-01-01T00:00:00.000Z'))),
    ).post('/boom');
    const cursor = await request(appThrowing(new InvalidCursorError('!!!'))).post('/boom');

    expect(closed.status).toBe(422);
    expect(cursor.status).toBe(400);
  });

  it('answers 422 for an overdrawn account, with the shortfall as a decimal string', async () => {
    // The one domain error with extension members, and the one place a refactor could
    // silently reintroduce a JS `number` for an amount. `-250n` minor units of EUR must
    // come out as the string "-2.50", never the number -2.5.
    const response = await request(
      appThrowing(
        new AccountOverdrawnError(
          'acct-1',
          { currency: 'EUR', amountMinor: -250n },
          new Date('2026-03-01T12:00:00.000Z'),
        ),
      ),
    ).post('/boom');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('ACCOUNT_OVERDRAWN');
    expect(response.body.accountId).toBe('acct-1');
    expect(response.body.currency).toBe('EUR');
    expect(response.body.occurredAt).toBe('2026-03-01T12:00:00.000Z');
    expect(response.body.shortfall).toBe('-2.50');
    expect(typeof response.body.shortfall).toBe('string');
  });
});

describe('errors that are not domain errors', () => {
  it('become a 500 that leaks nothing', async () => {
    // The moment a caller is least entitled to detail. An unanticipated exception may carry
    // a connection string, a row, or a fragment of SQL.
    const leaky = new Error('connection to postgres://ledger_app:hunter2@db:5432 failed');
    const response = await request(appThrowing(leaky)).post('/boom');

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
    expect(JSON.stringify(response.body)).not.toContain('postgres://');
  });

  it('still carry a request id, so the log line can be found', async () => {
    const response = await request(appThrowing(new Error('boom'))).post('/boom');

    expect(response.body.requestId).toBe(response.headers['x-request-id']);
    expect(response.body.detail).toContain('request id');
  });

  it('can be exposed deliberately, for a test that needs to see them', async () => {
    const response = await request(appThrowing(new Error('the real cause'), { exposeInternalErrors: true })).post(
      '/boom',
    );

    expect(response.body.detail).toContain('the real cause');
  });
});

describe('the body parser', () => {
  it('answers 400, not 500, for a body that is not JSON', async () => {
    // Never reaches a handler, so this is the only place it can be answered - and the one
    // error where the client most needs to be told the mistake is theirs.
    const app = createTestApp({
      definitions: [
        route({
          method: 'post',
          path: '/echo',
          handler: (_request, response) => {
            response.json({ ok: true });
          },
        }),
      ],
    });

    const response = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{ not json');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  });
});

describe('unmatched routes', () => {
  it('are a problem document too, not an HTML error page', async () => {
    const response = await request(createTestApp({ definitions: [] })).get('/nothing/here');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.body.code).toBe('ROUTE_NOT_FOUND');
    expect(response.body.detail).toContain('GET /nothing/here');
  });
});

describe('the request id', () => {
  const app = () =>
    createTestApp({
      definitions: [
        route({
          handler: (_request, response) => {
            response.json({ ok: true });
          },
        }),
      ],
    });

  it('is generated when the client sends none', async () => {
    const response = await request(app()).get('/probe');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours an inbound id, so a trace started upstream stays one trace', async () => {
    const response = await request(app()).get('/probe').set('X-Request-Id', 'trace-abc-123');
    expect(response.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('refuses an inbound id that could forge a log entry', async () => {
    // The value is attacker-controlled and ends up in a response header and in structured
    // logs. A newline in it is how a log file acquires an entry nobody wrote.
    const response = await request(app()).get('/probe').set('X-Request-Id', 'abc def');

    expect(response.headers['x-request-id']).not.toBe('abc def');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses an absurdly long inbound id', async () => {
    const response = await request(app()).get('/probe').set('X-Request-Id', 'a'.repeat(500));
    expect(response.headers['x-request-id']).toHaveLength(36);
  });
});
