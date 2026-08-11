import type { RequestHandler } from 'express';
import type { z } from 'zod';
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
   * A valid access token, and nothing more. For operations where no book can be named in the
   * request - either because it does not exist yet, as with creating one, or because the
   * caller does not yet know which books are theirs, as with listing them. There is no
   * membership to check against a book neither the path nor the caller can identify; the
   * handler's own query is what scopes the answer.
   */
  | { readonly kind: 'authenticated' }
  /** A permission, checked against the caller's role in the resolved book. */
  | { readonly kind: 'book'; readonly permission: Permission; readonly bookFrom: BookSource };

export type RouteMethod = 'get' | 'post';

export interface RouteDefinition {
  readonly method: RouteMethod;
  readonly path: string;
  readonly access: RouteAccess;
  /** One line, for the audit output and for the OpenAPI summary. */
  readonly summary: string;
  /**
   * What the request has to look like, and what the row's own handler parses it with.
   *
   * These are the schemas the enforcement uses, not a description of them written beside it.
   * A query schema is read out of the definition by the handler; a body schema is the same
   * value the service parses, imported once and referenced here. So a shape that appears in
   * the published spec but is enforced nowhere is not a thing this table can express - which
   * is the entire reason the fields are here rather than in the generator.
   *
   * `params` is the exception, and the only one: the authorize guard resolves the book from
   * the path before the handler runs, and it does that through `uuidPathParam`. The schema
   * here declares the same parameter for the spec to list, but it is a second expression of
   * one rule. Changing one without the other is possible, and `openapi.test.ts` will not
   * catch it.
   */
  readonly request?: {
    readonly params?: z.ZodType;
    readonly query?: z.ZodType;
    readonly body?: z.ZodType;
  };
  /**
   * The 2xx body. The status it is returned with.
   *
   * `schema` is absent where there is no body - a 204 is a status and nothing else.
   */
  readonly response?: { readonly status: number; readonly schema?: z.ZodType };
  /**
   * Other statuses this route answers with on success, carrying the same body.
   *
   * One route needs it: posting an entry whose `externalId` was used before returns the entry
   * that already exists, with a 200 rather than a 201. A spec that documented only the 201
   * would be describing something the route does not always do.
   */
  readonly alsoAnswers?: readonly { readonly status: number; readonly description: string }[];
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
