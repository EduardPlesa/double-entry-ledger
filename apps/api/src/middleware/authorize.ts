import type { RequestHandler } from 'express';
import { setBookAccess, setPrincipal, principalOf } from '../http/context.js';
import { uuidPathParam } from '../http/validate.js';
import type { AccessService } from '../services/access.service.js';
import { acceptsIdempotencyKey, type BookSource, type RouteAccess, type RouteDefinition } from '../routes/registry.js';

/**
 * The guards, and the only place a route's access requirement is enforced.
 *
 * They are thin: every decision is in `AccessService`, and these translate between Express
 * and it. That split is what lets the interesting cases - a key for another book, a viewer
 * posting an entry, a non-member with a valid id - be tested without an HTTP request, and
 * what keeps the middleware short enough to read in one go.
 *
 * `guardsFor` is the function `http/app.ts` applies to every route in the registry. There is
 * no per-route opportunity to forget one, because the app does not register a route any other
 * way.
 */

export interface GuardDependencies {
  readonly access: AccessService;
  /** Applied to the POST routes that are scoped to a book. See `acceptsIdempotencyKey`. */
  readonly idempotency: RequestHandler;
}

export function createGuards(dependencies: GuardDependencies) {
  const { access } = dependencies;

  const authenticate: RequestHandler = async (request, response, next) => {
    setPrincipal(response, await access.authenticate(request.get('authorization')));
    next();
  };

  const authorize = (routeAccess: Extract<RouteAccess, { kind: 'book' }>): RequestHandler => {
    return async (request, response, next) => {
      const id = uuidPathParam(request.params, PARAM_NAMES[routeAccess.bookFrom]);
      const bookId = await access.resolveBookId(routeAccess.bookFrom, id);

      setBookAccess(response, await access.authorize(principalOf(response), bookId, routeAccess.permission));
      next();
    };
  };

  return function guardsFor(definition: RouteDefinition): readonly RequestHandler[] {
    const routeAccess = definition.access;

    switch (routeAccess.kind) {
      case 'public':
        return [];
      case 'authenticated':
        return [authenticate];
      case 'book': {
        // The order is not negotiable. Authorization needs a principal to authorize, and
        // idempotency needs the book that authorization resolved - the reservation table is
        // keyed on it, and reserving under an unauthorised book would let a caller occupy a
        // key in a book they cannot reach.
        const chain = [authenticate, authorize(routeAccess)];

        return acceptsIdempotencyKey(definition)
          ? [...chain, dependencies.idempotency]
          : chain;
      }
    }
  };
}

/**
 * Which path parameter each route kind resolves its book from.
 *
 * Validated as a UUID before it goes anywhere: without that check,
 * `/accounts/not-a-uuid/balance` reaches Postgres and comes back as `22P02 invalid input
 * syntax for type uuid` - a 500 for what is plainly a client mistake, and one that also tells
 * the client its input got as far as the database.
 */
export const PARAM_NAMES: Record<BookSource, string> = {
  param: 'bookId',
  account: 'accountId',
  entry: 'entryId',
};
