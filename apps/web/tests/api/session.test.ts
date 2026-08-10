import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAccessToken, onSessionLost, refreshSession, setAccessToken } from '../../src/api/session';

function sessionResponse(accessToken: string): Response {
  return new Response(
    JSON.stringify({
      accessToken,
      tokenType: 'Bearer',
      expiresAt: '2026-08-05T12:10:00.000Z',
      user: { id: 'user-1', email: 'someone@example.com' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  setAccessToken(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the access token', () => {
  it('is held in memory and never written to storage', () => {
    setAccessToken('token-1');

    expect(getAccessToken()).toBe('token-1');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});

describe('refreshSession', () => {
  it('posts to /auth/refresh with credentials and stores the new token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse('token-2'));

    const session = await refreshSession();

    expect(session?.token).toBe('token-2');
    expect(getAccessToken()).toBe('token-2');

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('/auth/refresh');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
  });

  it('runs one request when called concurrently, and gives both callers the same session', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse('token-3'));

    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);

    expect(first?.token).toBe('token-3');
    expect(second?.token).toBe('token-3');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the token and notifies listeners when the refresh is refused', async () => {
    setAccessToken('stale');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'UNAUTHENTICATED', status: 401 }), {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );

    const lost = vi.fn();
    onSessionLost(lost);

    const session = await refreshSession();

    expect(session).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('returns the user the refresh answered with, alongside the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse('token-4'));

    const session = await refreshSession();

    expect(session).toEqual({ token: 'token-4', user: { id: 'user-1', email: 'someone@example.com' } });
  });

  it('treats a network failure as a lost session rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(refreshSession()).resolves.toBeNull();
  });

  it('stops notifying a listener that unsubscribed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));

    const lost = vi.fn();
    onSessionLost(lost)();

    await refreshSession();

    expect(lost).not.toHaveBeenCalled();
  });
});
