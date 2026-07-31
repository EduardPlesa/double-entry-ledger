import type { Request, RequestHandler, Response } from 'express';
import { UnauthenticatedError } from '../domain/errors.js';
import { clearRefreshCookie, refreshCookieOf, setRefreshCookie } from '../http/cookies.js';
import type { AuthService, SessionContext, SessionResult } from '../services/auth.service.js';
import type { RouteDefinition } from './registry.js';

/**
 * The four endpoints that hand out and take away sessions.
 *
 * All four are `public` in the registry, which is not the same as unauthenticated: refresh
 * and logout authenticate with the cookie rather than with a bearer token, and the registry's
 * `access` describes what the guard middleware must check, not whether a credential is
 * involved. A route that authenticated itself and also declared `authenticated` would be
 * checked twice, against two different credentials, and would fail.
 */

export interface AuthRouteDependencies {
  readonly auth: AuthService;
}

export function authRoutes(dependencies: AuthRouteDependencies): RouteDefinition[] {
  const { auth } = dependencies;

  const register: RequestHandler = async (request, response) => {
    const session = await auth.register(request.body, sessionContext(request));
    respondWithSession(response, session, 201);
  };

  const login: RequestHandler = async (request, response) => {
    const session = await auth.login(request.body, sessionContext(request));
    respondWithSession(response, session, 200);
  };

  const refresh: RequestHandler = async (request, response) => {
    const presented = refreshCookieOf(request);

    // No cookie at all is the same answer as a bad one. Distinguishing them would tell an
    // attacker whether the value they sent was structurally plausible.
    if (presented === null) throw new UnauthenticatedError('no refresh cookie was presented');

    try {
      const session = await auth.refresh(presented, sessionContext(request));
      respondWithSession(response, session, 200);
    } catch (error) {
      // The cookie is dead either way - rotated, expired, or revoked along with its family -
      // so clear it. Leaving it in place means the browser keeps presenting a credential that
      // can never work again, and every subsequent failure looks like a new incident.
      clearRefreshCookie(response);
      throw error;
    }
  };

  const logout: RequestHandler = async (request, response) => {
    await auth.logout(refreshCookieOf(request));
    clearRefreshCookie(response);
    response.status(204).end();
  };

  return [
    {
      method: 'post',
      path: '/auth/register',
      access: { kind: 'public' },
      summary: 'Create an account and start a session',
      handler: register,
    },
    {
      method: 'post',
      path: '/auth/login',
      access: { kind: 'public' },
      summary: 'Exchange credentials for a session',
      handler: login,
    },
    {
      method: 'post',
      path: '/auth/refresh',
      access: { kind: 'public' },
      summary: 'Rotate the refresh token and issue a new access token',
      handler: refresh,
    },
    {
      method: 'post',
      path: '/auth/logout',
      access: { kind: 'public' },
      summary: 'Revoke the session',
      handler: logout,
    },
  ];
}

/**
 * The access token in the body, the refresh token in the cookie, and never the other way
 * round. `expiresIn` is seconds rather than a timestamp so a client does not have to trust
 * its own clock to know when to refresh.
 */
function respondWithSession(response: Response, session: SessionResult, status: number): void {
  setRefreshCookie(response, session.refreshToken, session.refreshTokenExpiresAt);

  response.status(status).json({
    accessToken: session.accessToken,
    tokenType: 'Bearer',
    expiresAt: session.accessTokenExpiresAt.toISOString(),
    user: {
      id: session.user.id,
      email: session.user.email,
    },
  });
}

function sessionContext(request: Request): SessionContext {
  return {
    // Truncated, because both end up in a row that is kept for the incident report and
    // neither is trusted for anything. A header is whatever the client says it is.
    userAgent: request.get('user-agent')?.slice(0, 500) ?? null,
    ip: request.ip?.slice(0, 100) ?? null,
  };
}
