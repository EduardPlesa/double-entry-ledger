import type { DomainErrorCode } from '../domain/errors.js';

/**
 * What a problem document can be about: a domain error, or one of the two failures that are
 * not domain concepts at all - a path this API does not serve, and a bug.
 */
export type ProblemCode = DomainErrorCode | 'ROUTE_NOT_FOUND' | 'INTERNAL_ERROR';

/**
 * RFC 9457 Problem Details.
 *
 * The point of the format is that a client can handle an error it has never seen: `status`
 * for the category, `type` as a stable identifier to branch on, `title` and `detail` for a
 * human. What it replaces is the house-style `{ error: "something went wrong" }` that every
 * service invents slightly differently and every client parses slightly wrongly.
 *
 * Two extensions beyond the RFC, both of which it explicitly allows:
 *
 *   `code`       the domain error code. `type` is a URI and reads as one; `code` is what
 *                a switch statement in a client is actually going to match on.
 *   `requestId`  the id echoed in X-Request-Id. Stage 6 puts it in the error toast, so a
 *                user can read out the one string that finds their failure in the logs.
 */

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * The base URI for problem types. Not resolvable, and deliberately not a real domain: a
 * `type` is an identifier, and RFC 9457 is explicit that dereferencing it is optional. A URL
 * pointing at documentation that does not exist yet is worse than one that never claimed to.
 */
const PROBLEM_TYPE_BASE = 'https://ledger.local/problems/';

export interface ProblemDetail {
  readonly path: string;
  readonly message: string;
}

export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  /** The path that produced it. */
  readonly instance: string;
  readonly code: ProblemCode;
  readonly requestId: string;
  /** Field-level detail, on validation failures only. */
  readonly errors?: readonly ProblemDetail[];
}

export interface ProblemInput {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly code: ProblemCode;
  readonly instance: string;
  readonly requestId: string;
  readonly errors?: readonly ProblemDetail[] | undefined;
}

export function problem(input: ProblemInput): ProblemDocument {
  return {
    type: `${PROBLEM_TYPE_BASE}${toSlug(input.code)}`,
    title: input.title,
    status: input.status,
    detail: input.detail,
    instance: input.instance,
    code: input.code,
    requestId: input.requestId,
    ...(input.errors !== undefined && input.errors.length > 0 ? { errors: input.errors } : {}),
  };
}

/** `ENTRY_UNBALANCED` becomes `entry-unbalanced`, which is what a URI path segment should look like. */
function toSlug(code: string): string {
  return code.toLowerCase().replaceAll('_', '-');
}
