import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from '../../src/api/problem';

function problemResponse(body: unknown, status = 422): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

describe('toApiError', () => {
  it('reads the code, the detail and the request id a problem document carries', async () => {
    const error = await toApiError(
      problemResponse({
        type: 'https://ledger.local/problems/account-overdrawn',
        title: 'Account overdrawn',
        status: 422,
        detail: 'account 3f4d would be overdrawn',
        instance: '/books/1/entries',
        code: 'ACCOUNT_OVERDRAWN',
        requestId: 'req-123',
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('ACCOUNT_OVERDRAWN');
    expect(error.detail).toBe('account 3f4d would be overdrawn');
    expect(error.requestId).toBe('req-123');
    expect(error.errors).toEqual([]);
  });

  it('carries field errors through, for a validation failure', async () => {
    const error = await toApiError(
      problemResponse(
        {
          title: 'Validation failed',
          status: 400,
          detail: 'invalid request body',
          code: 'VALIDATION_FAILED',
          requestId: 'req-456',
          errors: [{ path: 'legs.0.amount', message: 'must not be blank' }],
        },
        400,
      ),
    );

    expect(error.errors).toEqual([{ path: 'legs.0.amount', message: 'must not be blank' }]);
  });

  it('survives a response that is not a problem document at all', async () => {
    const error = await toApiError(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    expect(error.status).toBe(502);
    expect(error.code).toBe('UNKNOWN');
    expect(error.requestId).toBeNull();
    expect(error.detail).not.toBe('');
  });

  it('falls back to the X-Request-Id header when the body has no requestId', async () => {
    const response = new Response(JSON.stringify({ status: 500, code: 'INTERNAL_ERROR' }), {
      status: 500,
      headers: { 'content-type': 'application/problem+json', 'x-request-id': 'req-789' },
    });

    const error = await toApiError(response);

    expect(error.requestId).toBe('req-789');
  });

  it('keeps extension members, so a caller can read the overdraft shortfall', async () => {
    const error = await toApiError(
      problemResponse({
        status: 422,
        code: 'ACCOUNT_OVERDRAWN',
        detail: 'overdrawn',
        requestId: 'req-1',
        accountId: 'acc-1',
        shortfall: { currency: 'EUR', amount: '5.00' },
      }),
    );

    expect(error.extensions.accountId).toBe('acc-1');
  });
});
