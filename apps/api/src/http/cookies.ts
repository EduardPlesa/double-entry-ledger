import type { CookieOptions, Request, Response } from 'express';

/**
 * The refresh cookie.
 *
 * The access token is returned in the response body and held in memory by the frontend; the
 * refresh token is a cookie and is never visible to JavaScript. That split is the point of
 * having two tokens at all. A token in `localStorage` is readable by any script that manages
 * to run on the page, and a token in an httpOnly cookie is not - so the credential with the
 * long life is the one script cannot reach, and the one script can reach expires in ten
 * minutes.
 *
 * Every attribute below is doing a job:
 *
 *   httpOnly  no script may read it, which is the whole argument above.
 *   secure    never sent over plain HTTP. Unconditional, including in development, because
 *             browsers treat http://localhost as a secure context - so this costs nothing
 *             locally and cannot be forgotten when it stops being local.
 *   sameSite  'lax' so a cross-site POST cannot silently carry the cookie, which is the CSRF
 *             case that matters here. Not 'strict', which would also drop the cookie when a
 *             user arrives by following a link, and that is a real flow.
 *   path      '/auth'. The cookie is attached to refresh and logout and to nothing else, so
 *             the ordinary API surface never receives a credential it has no use for.
 */

export const REFRESH_COOKIE_NAME = 'refresh_token';

/** Scoped to the auth endpoints, and nothing else. */
export const REFRESH_COOKIE_PATH = '/auth';

function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(response: Response, token: string, expiresAt: Date): void {
  response.cookie(REFRESH_COOKIE_NAME, token, { ...baseOptions(), expires: expiresAt });
}

/**
 * Clears it, with the same attributes it was set with.
 *
 * A browser matches a deletion against name, domain and path. Clearing with a different path
 * leaves the original cookie exactly where it was, and the bug looks like "logout sometimes
 * does not work" - which is not a bug anyone enjoys finding.
 */
export function clearRefreshCookie(response: Response): void {
  response.clearCookie(REFRESH_COOKIE_NAME, baseOptions());
}

export function refreshCookieOf(request: Request): string | null {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
