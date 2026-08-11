import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, newIdempotencyKey } from '../../src/api/client';
import { ApiError } from '../../src/api/problem';
import { setAccessToken } from '../../src/api/session';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(code: string, status: number): Response {
  return new Response(JSON.stringify({ code, status, detail: code, requestId: 'req-1' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

function headersOf(call: Parameters<typeof fetch> | undefined): Headers {
  return new Headers(call?.[1]?.headers);
}

beforeEach(() => {
  setAccessToken(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiFetch', () => {
  it('returns the parsed body of a successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([{ id: 'book-1' }]));

    await expect(apiFetch('/books')).resolves.toEqual([{ id: 'book-1' }]);
  });

  it('attaches the bearer token when there is one, and no header when there is not', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({}));

    await apiFetch('/books');
    expect(headersOf(fetchSpy.mock.calls[0]).has('authorization')).toBe(false);

    setAccessToken('token-1');
    await apiFetch('/books');
    expect(headersOf(fetchSpy.mock.calls[1]).get('authorization')).toBe('Bearer token-1');
  });

  it('sends a JSON body on a POST and sets the content type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ id: 'book-1' }, 201));

    await apiFetch('/books', { method: 'POST', body: { name: 'Test book' } });

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ name: 'Test book' }));
    expect(headersOf(fetchSpy.mock.calls[0]).get('content-type')).toBe('application/json');
  });

  it('sends the idempotency key it was given, and none when it was given none', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({}, 201))
      .mockResolvedValueOnce(json({}, 201));

    await apiFetch('/books/1/entries', { method: 'POST', body: {}, idempotencyKey: 'key-1' });
    expect(headersOf(fetchSpy.mock.calls[0]).get('idempotency-key')).toBe('key-1');

    await apiFetch('/books', { method: 'POST', body: {} });
    expect(headersOf(fetchSpy.mock.calls[1]).has('idempotency-key')).toBe(false);
  });

  it('returns undefined for a 204, rather than failing to parse an empty body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiFetch('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('throws an ApiError carrying the code and the request id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem('ACCOUNT_OVERDRAWN', 422));

    const error = await apiFetch('/books/1/entries', { method: 'POST', body: {} }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('ACCOUNT_OVERDRAWN');
    expect((error as ApiError).requestId).toBe('req-1');
  });

  it('refreshes once on a 401 and replays the original request with the new token', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401))
      .mockResolvedValueOnce(
        json({ accessToken: 'token-2', user: { id: 'u', email: 'e@example.com' } }),
      )
      .mockResolvedValueOnce(json([{ id: 'book-1' }]));

    setAccessToken('token-1');

    await expect(apiFetch('/books')).resolves.toEqual([{ id: 'book-1' }]);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('/auth/refresh');
    expect(headersOf(fetchSpy.mock.calls[2]).get('authorization')).toBe('Bearer token-2');
  });

  it('replays a POST with the same idempotency key, so a retry is a retry', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401))
      .mockResolvedValueOnce(json({ accessToken: 'token-2', user: { id: 'u', email: 'e@example.com' } }))
      .mockResolvedValueOnce(json({ id: 'entry-1' }, 201));

    await apiFetch('/books/1/entries', { method: 'POST', body: {}, idempotencyKey: 'key-9' });

    expect(headersOf(fetchSpy.mock.calls[0]).get('idempotency-key')).toBe('key-9');
    expect(headersOf(fetchSpy.mock.calls[2]).get('idempotency-key')).toBe('key-9');
  });

  it('gives up after one refresh: a second 401 is thrown, not retried again', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401))
      .mockResolvedValueOnce(json({ accessToken: 'token-2', user: { id: 'u', email: 'e@example.com' } }))
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401));

    await expect(apiFetch('/books')).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the refresh itself fails', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401))
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401));

    await expect(apiFetch('/books')).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not refresh on any other 4xx', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem('FORBIDDEN', 403));

    await expect(apiFetch('/books/1/accounts')).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on a 401 from an auth endpoint - that 401 is about the credential just sent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem('UNAUTHENTICATED', 401));

    const error = await apiFetch('/auth/login', { method: 'POST', body: {} }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.some((call) => call[0] === '/auth/refresh')).toBe(false);
  });

  it('shares one refresh between two concurrent 401s, and replays both with the new token', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401)) // /books, initial
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401)) // /accounts, initial
      .mockResolvedValueOnce(
        json({ accessToken: 'token-2', user: { id: 'u', email: 'e@example.com' } }),
      ) // the one refresh
      .mockResolvedValueOnce(json([{ id: 'book-1' }])) // /books, replay
      .mockResolvedValueOnce(json([{ id: 'account-1' }])); // /accounts, replay

    setAccessToken('token-1');

    const [books, accounts] = await Promise.all([
      apiFetch('/books'),
      apiFetch('/accounts'),
    ]);

    expect(books).toEqual([{ id: 'book-1' }]);
    expect(accounts).toEqual([{ id: 'account-1' }]);

    const refreshCalls = fetchSpy.mock.calls.filter((call) => call[0] === '/auth/refresh');
    expect(refreshCalls).toHaveLength(1);

    const replayHeaders = fetchSpy.mock.calls
      .slice(3)
      .map((call) => headersOf(call).get('authorization'));
    expect(replayHeaders).toEqual(['Bearer token-2', 'Bearer token-2']);
  });
  it('reports the status of a successful response, so 200 and 201 can be told apart', async () => {
    const seen: number[] = [];
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ id: 'entry-1' }, 201))
      .mockResolvedValueOnce(json({ id: 'entry-1' }, 200));

    const onStatus = (status: number) => seen.push(status);
    await apiFetch('/books/1/entries', { method: 'POST', body: {}, onStatus });
    await apiFetch('/books/1/entries', { method: 'POST', body: {}, onStatus });

    expect(seen).toEqual([201, 200]);
  });
});

describe('newIdempotencyKey', () => {
  it('returns a fresh value each call', () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});
