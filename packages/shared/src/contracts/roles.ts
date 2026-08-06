/**
 * The three per-book roles, matching the `book_role` Postgres enum.
 *
 * Here rather than in the API because a response type names a role: `GET /books` tells the
 * caller what they may do in each book, so the client can decline to offer what the policy
 * forbids. What a role *may do* is not here - `apps/api/src/domain/policy.ts` remains the
 * only authority on that, and moving it would put an authorization decision in a package the
 * browser downloads.
 */
export const BOOK_ROLES = ['owner', 'accountant', 'viewer'] as const;

export type BookRole = (typeof BOOK_ROLES)[number];
