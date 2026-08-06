/**
 * Who may do what, in one map.
 *
 * This is the only authority on authorization in the system. Not one map plus a helper that
 * "just also allows owners", not a second check in a route that looked incomplete: every
 * decision reads this table, and the meta-test in `tests/http` fails the build if a route is
 * ever registered without naming a permission from it.
 *
 * The reason for a single map rather than a decorator per handler is that the interesting
 * question about an authorization system is not "what does this route require" - you can
 * read that at the route - but "what can an accountant do", and that question has an answer
 * here and nowhere else.
 */

import { BOOK_ROLES, type BookRole } from '@ledger/shared';

export { BOOK_ROLES, type BookRole };

export const POLICY = {
  'book:read': ['owner', 'accountant', 'viewer'],
  'account:create': ['owner', 'accountant'],
  'entry:post': ['owner', 'accountant'],
  'entry:reverse': ['owner', 'accountant'],
  'period:close': ['owner'],
  'member:manage': ['owner'],
} as const;

export type Permission = keyof typeof POLICY;

export const PERMISSIONS = Object.keys(POLICY) as readonly Permission[];

/**
 * There is deliberately no `entry:delete` and no `entry:update`, and there is not going to
 * be one. Those operations do not exist in this domain - a mistake is corrected by recording
 * a reversing entry, and the database will refuse an UPDATE or a DELETE against history from
 * any role at all. A permission for an operation the system cannot perform would be a
 * promise the policy map cannot keep, and the first thing someone would do with it is write
 * the operation.
 *
 * `tests/unit/policy.test.ts` asserts this in a way that fails if it is ever added.
 */

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(POLICY, value);
}

export function isBookRole(value: string): value is BookRole {
  return (BOOK_ROLES as readonly string[]).includes(value);
}

/** Whether a role carries a permission. The whole of the authorization decision. */
export function can(role: BookRole, permission: Permission): boolean {
  return (POLICY[permission] as readonly BookRole[]).includes(role);
}

/** Every permission a role carries. For explaining a 403, and for tests. */
export function permissionsOf(role: BookRole): readonly Permission[] {
  return PERMISSIONS.filter((permission) => can(role, permission));
}
