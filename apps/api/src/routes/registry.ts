import type { RequestHandler } from 'express';
import type { Permission } from '../domain/policy.js';

/**
 * Every route, and what it requires, in one list.
 *
 * Routes are not registered by the modules that define them. Each module exports handlers;
 * this table is what turns them into an application, and `http/app.ts` walks it. That
 * indirection buys one specific thing: there is no way to add a route without adding a row
 * here, and every row has to say what it requires, because `access` is not optional.
 *
 * The meta-test in `tests/http/routes.meta.test.ts` enforces the other half - that nothing
 * reached the app by some other path - by comparing this table against what Express actually
 * has registered. Together they make "every route declares a permission" a fact rather than
 * a convention.
 */

/**
 * Where the book comes from, for a route that needs one.
 *
 * `param` is a `:bookId` in the path. The other two are ids of things that belong to a book,
 * resolved through the SECURITY DEFINER lookup functions from migration 0006 - which is the
 * only way to find the book of an account when reading accounts is itself behind the policy
 * keyed on that book.
 */
export type BookSource = 'param' | 'account' | 'entry';

export type RouteAccess =
  /** No credential required. The auth endpoints, and health. */
  | { readonly kind: 'public' }
  /**
   * A valid access token, and nothing more. Only for operations that are not about a book
   * that already exists - creating one, most obviously, since there is no membership to
   * check against a book that does not exist yet.
   */
  | { readonly kind: 'authenticated' }
  /** A permission, checked against the caller's role in the resolved book. */
  | { readonly kind: 'book'; readonly permission: Permission; readonly bookFrom: BookSource };

export type RouteMethod = 'get' | 'post';

export interface RouteDefinition {
  readonly method: RouteMethod;
  readonly path: string;
  readonly access: RouteAccess;
  /** One line, for the audit output and eventually for the OpenAPI summary in stage 7. */
  readonly summary: string;
  readonly handler: RequestHandler;
}

/**
 * Whether a route honours `Idempotency-Key`.
 *
 * Derived rather than declared, so it cannot be set wrong on a route. Two conditions: it must
 * be a POST, since a GET is already idempotent and a key on one would be a promise about
 * something that needs no promise; and it must be book-scoped, because the reservation table
 * is keyed on `(book_id, key)` and there is no book to key it on before one exists. That
 * leaves `POST /books` and the auth endpoints without replay protection, which is the honest
 * outcome - creating a second book is not the failure mode this header defends against.
 */
export function acceptsIdempotencyKey(definition: RouteDefinition): boolean {
  return definition.method === 'post' && definition.access.kind === 'book';
}
