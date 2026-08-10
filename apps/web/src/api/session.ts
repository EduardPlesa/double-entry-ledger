/**
 * The access token, and the one call that renews it.
 *
 * The token lives in a module variable and nowhere else. `apps/api/src/http/cookies.ts`
 * already makes the argument for the refresh token: a credential a script can read is a
 * credential an XSS takes, which is why that one is `httpOnly`. Putting the access token in
 * `localStorage` would hand back exactly what that decision bought - so it is held here, and
 * a page reload starts with no token at all. The refresh cookie survives the reload, so boot
 * calls `refreshSession` once and the session comes back without the user seeing a login form.
 *
 * The refresh is single-flight. Several queries can fail with a 401 in the same tick, and
 * refresh *rotates* the token: the second request to arrive would present a cookie the first
 * has already redeemed, which the API treats as reuse - and reuse revokes the entire token
 * family. Concurrent callers therefore share one in-flight promise, and the second caller
 * getting the first caller's token is the correct outcome, not a shortcut.
 *
 * This module must not import the API client. The client calls `refreshSession` when it sees
 * a 401; a refresh routed back through the client would recurse through its own 401 handler.
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string;
}

let accessToken: string | null = null;
let currentUser: SessionUser | null = null;
let inFlight: Promise<string | null> | null = null;

const listeners = new Set<() => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * Whoever the last refresh answered with.
 *
 * `POST /auth/refresh` returns the user alongside the token, so recording it here costs
 * nothing and saves the boot path an identical second call to learn who it just refreshed.
 */
export function getSessionUser(): SessionUser | null {
  return currentUser;
}

/** Called when the refresh cookie is dead: expired, rotated away, or revoked with its family. */
export function onSessionLost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function refreshSession(): Promise<string | null> {
  inFlight ??= runRefresh().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

async function runRefresh(): Promise<string | null> {
  try {
    const response = await fetch('/auth/refresh', {
      method: 'POST',
      // The refresh cookie is the credential. Same-origin through the dev proxy, but stated
      // explicitly so this does not depend on a default that varies by browser.
      credentials: 'include',
      headers: { accept: 'application/json' },
    });

    if (!response.ok) return loseSession();

    const body: unknown = await response.json();
    const { accessToken: token, user } = body as { accessToken?: unknown; user?: unknown };

    if (typeof token !== 'string') return loseSession();

    accessToken = token;
    currentUser = sessionUserOf(user);
    return token;
  } catch {
    // A network failure is indistinguishable from a dead cookie from here, and treating it as
    // a thrown error would make every caller handle it. The user is signed out; if the
    // network was the cause, signing in again is what they were going to do anyway.
    return loseSession();
  }
}

function loseSession(): null {
  accessToken = null;
  currentUser = null;
  for (const listener of listeners) listener();
  return null;
}

function sessionUserOf(value: unknown): SessionUser | null {
  if (typeof value !== 'object' || value === null) return null;

  const { id, email } = value as { id?: unknown; email?: unknown };
  return typeof id === 'string' && typeof email === 'string' ? { id, email } : null;
}
