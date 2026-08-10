import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAccessToken,
  getSessionUser,
  onSessionLost,
  refreshSession,
  setAccessToken,
} from '../../src/api/session';

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

    const token = await refreshSession();

    expect(token).toBe('token-2');
    expect(getAccessToken()).toBe('token-2');

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('/auth/refresh');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
  });

  it('runs one request when called concurrently, and gives both callers the same token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse('token-3'));

    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);

    expect(first).toBe('token-3');
    expect(second).toBe('token-3');
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

    const token = await refreshSession();

    expect(token).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('records the user the refresh answered with', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse('token-4'));

    await refreshSession();

    expect(getSessionUser()).toEqual({ id: 'user-1', email: 'someone@example.com' });
  });

  it('clears the recorded user when the refresh is refused', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sessionResponse('token-5'));
    await refreshSession();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    await refreshSession();

    expect(getSessionUser()).toBeNull();
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
