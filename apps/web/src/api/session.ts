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
 * That single flight is per tab, not per browser. Two tabs of the same session waking together
 * - from sleep, from being restored - each hold their own module instance of this file and can
 * both present the same refresh cookie in the same instant. One wins the compare-and-swap in
 * `apps/api/src/services/auth.service.ts`; the other looks exactly like reuse, and reuse
 * revokes the whole token family, signing both tabs out. `auth.service.ts`'s own docblock
 * names "two browser tabs waking together" as a cost it accepts deliberately, and this module
 * is where that acceptance becomes concrete: the guarantee here is one refresh per tab, never
 * one refresh per browser. Coordinating across tabs - so only one of them ever calls
 * `/auth/refresh` - would need the Web Locks API or a `BroadcastChannel` election, and this
 * stage does not build either. A user who keeps two tabs open and lets both go idle past the
 * access token's lifetime will occasionally see both signed out at once; that is a known limit,
 * not a bug to file.
 *
 * This module must not import the API client. The client calls `refreshSession` when it sees
 * a 401; a refresh routed back through the client would recurse through its own 401 handler.
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string;
}

export interface Session {
  readonly token: string;
  readonly user: SessionUser;
}

let accessToken: string | null = null;
let inFlight: Promise<Session | null> | null = null;

const listeners = new Set<() => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Called when the refresh cookie is dead: expired, rotated away, or revoked with its family. */
export function onSessionLost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Redeems the refresh cookie for a new access token and the identity it belongs to.
 *
 * `POST /auth/refresh` returns the user alongside the token in one body, so this returns both
 * rather than making a caller that needs to know who signed in make a second, identical call.
 */
export async function refreshSession(): Promise<Session | null> {
  inFlight ??= runRefresh().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

async function runRefresh(): Promise<Session | null> {
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
    const { accessToken: token, user: rawUser } = body as { accessToken?: unknown; user?: unknown };
    const user = sessionUserOf(rawUser);

    if (typeof token !== 'string' || user === null) return loseSession();

    accessToken = token;
    return { token, user };
  } catch {
    // A network failure is indistinguishable from a dead cookie from here, and treating it as
    // a thrown error would make every caller handle it. The user is signed out; if the
    // network was the cause, signing in again is what they were going to do anyway.
    return loseSession();
  }
}

function loseSession(): null {
  accessToken = null;
  for (const listener of listeners) listener();
  return null;
}

function sessionUserOf(value: unknown): SessionUser | null {
  if (typeof value !== 'object' || value === null) return null;

  const { id, email } = value as { id?: unknown; email?: unknown };
  return typeof id === 'string' && typeof email === 'string' ? { id, email } : null;
}
