import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { AuthService } from '../services/auth.service.js';
import type { BookService } from '../services/book.service.js';
import type { LedgerService } from '../services/ledger.service.js';
import { authRoutes } from './auth.routes.js';
import { bookRoutes } from './books.routes.js';
import { docsRoutes } from './docs.routes.js';
import { ledgerRoutes } from './ledger.routes.js';
import type { RouteDefinition } from './registry.js';

/**
 * Every route in the application, assembled in one place.
 *
 * `http/app.ts` walks this list and nothing else. A route that is not here is not served,
 * and the meta-test fails the build if one ever reaches the app by another path.
 */

export interface RouteDependencies {
  readonly auth: AuthService;
  readonly books: BookService;
  readonly ledger: LedgerService;
}

export function allRoutes(dependencies: RouteDependencies): RouteDefinition[] {
  const served = [
    health(),
    ...authRoutes({ auth: dependencies.auth }),
    ...bookRoutes({ books: dependencies.books }),
    ...ledgerRoutes({ ledger: dependencies.ledger }),
  ];

  // The docs routes describe the whole list, themselves included, so they are handed a
  // function rather than the array they are about to become part of. It is called on the
  // first request to `/docs/openapi.json` and not before.
  const docs = docsRoutes({ definitions: () => [...served, ...docs] });

  return [...served, ...docs];
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
    response: { status: 200, schema: z.object({ status: z.literal('ok') }) },
    handler,
  };
}

