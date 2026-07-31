import type { Response } from 'express';
import type { BookRole } from '../domain/policy.js';

/**
 * What the guards worked out, carried to the handler.
 *
 * On `res.locals` rather than on `req`, and behind accessors rather than read directly. The
 * accessors throw when the value is missing, which is the right behaviour for something that
 * cannot legitimately be absent: a handler reading the book is a handler the authorize
 * middleware must have run for, and if it did not, the registry and the meta-test have
 * failed. Better a loud 500 than a handler quietly working with `undefined` as a book id.
 *
 * Declaration merging on `Express.Request` was the alternative. It would put these fields on
 * every request in the codebase as optional, which is exactly the shape that invites
 * `req.principal?.userId ?? ''` at a call site.
 */

/** Who is calling: a person with a session, or a machine with a key. */
export type Principal =
  | { readonly kind: 'user'; readonly userId: string }
  | {
      readonly kind: 'apiKey';
      readonly apiKeyId: string;
      /** A key is scoped to exactly one book, unlike a user, who may belong to many. */
      readonly bookId: string;
      readonly role: BookRole;
    };

export interface BookAccess {
  readonly bookId: string;
  readonly role: BookRole;
}

interface LedgerLocals {
  principal?: Principal;
  bookAccess?: BookAccess;
}

function locals(response: Response): LedgerLocals {
  return response.locals as LedgerLocals;
}

export function setPrincipal(response: Response, principal: Principal): void {
  locals(response).principal = principal;
}

export function principalOf(response: Response): Principal {
  const { principal } = locals(response);
  if (principal === undefined) {
    throw new Error('no principal on this request: a route ran without the authenticate guard');
  }
  return principal;
}

export function setBookAccess(response: Response, access: BookAccess): void {
  locals(response).bookAccess = access;
}

export function bookAccessOf(response: Response): BookAccess {
  const { bookAccess } = locals(response);
  if (bookAccess === undefined) {
    throw new Error('no book on this request: a route ran without the authorize guard');
  }
  return bookAccess;
}

/**
 * The user id to record on an entry, or null for a machine client.
 *
 * `entries` has a column for each, and exactly one is set. Both are nullable because the
 * rows written before either table existed can never be backfilled - the immutability
 * trigger sees to that.
 */
export function authorshipOf(principal: Principal): {
  createdByUserId: string | null;
  createdByApiKeyId: string | null;
} {
  return principal.kind === 'user'
    ? { createdByUserId: principal.userId, createdByApiKeyId: null }
    : { createdByUserId: null, createdByApiKeyId: principal.apiKeyId };
}
