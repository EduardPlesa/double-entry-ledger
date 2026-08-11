import type { RouteAccess, RouteDefinition } from '../routes/registry.js';

/**
 * What a route requires, derived from what it declares.
 *
 * The registry already knows: `public` needs nothing, `authenticated` needs a token, `book`
 * needs a token and a permission the token's holder has in that book. OpenAPI cannot express
 * the permission - it has no vocabulary for "editor in the book named by this path" - so the
 * permission goes in the operation's description, where a human reads it, rather than being
 * silently dropped.
 *
 * The schemes below are what `access.service.ts` actually reads, not a plausible-looking set:
 * one `Authorization: Bearer` header carrying either a JWT access token or an `lk_`-prefixed
 * API key, and one cookie. There is no second header, and inventing a `X-Api-Key` scheme here
 * would document an endpoint nobody can call.
 */

export type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

export interface SecurityScheme {
  readonly type: string;
  readonly description: string;
  readonly scheme?: string;
  readonly bearerFormat?: string;
  readonly in?: string;
  readonly name?: string;
}

export const securitySchemes: Readonly<Record<string, SecurityScheme>> = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    // Two credentials, one header, because `AccessService.authenticate` takes one string and
    // decides what it is from its shape. Splitting them into two schemes here would describe
    // a distinction the server does not make.
    description:
      'Either a JWT access token from `/auth/login`, or an API key issued by ' +
      '`POST /books/{bookId}/api-keys`. Both are presented as `Authorization: Bearer <value>`; ' +
      'a key is recognised by its `lk_` prefix.',
  },
  refreshCookie: {
    type: 'apiKey',
    in: 'cookie',
    name: 'refresh_token',
    description:
      'Set by the auth endpoints, httpOnly, scoped to `/auth`. Never readable by a script, ' +
      'which is the reason the short-lived access token is the one that lives in memory.',
  },
};

export function securityFor(definition: RouteDefinition): readonly SecurityRequirement[] {
  if (definition.credential === 'refreshCookie') return [{ refreshCookie: [] }];

  return definition.access.kind === 'public' ? [] : [{ bearerAuth: [] }];
}

/** The sentence about the permission that the security requirement cannot carry. */
export function permissionNote(access: RouteAccess): string | null {
  if (access.kind !== 'book') return null;

  const source =
    access.bookFrom === 'param'
      ? 'the book named in the path'
      : `the book that owns the ${access.bookFrom} named in the path`;

  return `Requires \`${access.permission}\` in ${source}.`;
}
