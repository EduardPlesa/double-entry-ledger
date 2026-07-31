import type { RequestHandler } from 'express';
import type { AuthService } from '../services/auth.service.js';
import { authRoutes } from './auth.routes.js';
import type { RouteAccess, RouteDefinition } from './registry.js';

/**
 * Every route in the application, assembled in one place.
 *
 * `http/app.ts` walks this list and nothing else. A route that is not here is not served,
 * and the meta-test fails the build if one ever reaches the app by another path.
 */

export interface RouteDependencies {
  readonly auth: AuthService;
}

export function allRoutes(dependencies: RouteDependencies): RouteDefinition[] {
  return [health(), ...authRoutes({ auth: dependencies.auth })];
}

/**
 * Liveness only. Deliberately does not touch the database: a health check that fails when
 * Postgres is briefly unreachable causes an orchestrator to restart a process that was
 * working, which turns a recoverable blip into an outage. Readiness, which does need to know
 * about dependencies, is a separate concern and not one this stage has a use for.
 */
function health(): RouteDefinition {
  const handler: RequestHandler = (_request, response) => {
    response.json({ status: 'ok' });
  };

  return {
    method: 'get',
    path: '/health',
    access: { kind: 'public' },
    summary: 'Liveness probe',
    handler,
  };
}

/**
 * The middleware enforcing each access requirement.
 *
 * Authentication and authorization arrive in the next commit; until then only `public` can be
 * satisfied, and the other two throw at wiring time rather than at request time. A guard that
 * quietly permitted what it could not check would be exactly the failure the whole registry
 * exists to prevent, and it would not show up in a test - the route would simply work.
 */
export function guardsFor(access: RouteAccess): readonly RequestHandler[] {
  if (access.kind === 'public') return [];

  throw new Error(
    `no guard is wired for access kind "${access.kind}" yet; refusing to register a route that would be unprotected`,
  );
}
