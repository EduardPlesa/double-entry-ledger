import { describe, expect, it } from 'vitest';
import {
  BOOK_ROLES,
  PERMISSIONS,
  POLICY,
  can,
  isBookRole,
  isPermission,
  permissionsOf,
} from '../../src/domain/policy.js';

describe('the policy map', () => {
  it('is exactly the six permissions, with exactly these roles', () => {
    // Written out rather than derived. A test that computes its expectation from the thing
    // under test passes whatever the map says, which is the one thing this must not do:
    // widening a permission should fail here and require someone to say so deliberately.
    expect(POLICY).toEqual({
      'book:read': ['owner', 'accountant', 'viewer'],
      'account:create': ['owner', 'accountant'],
      'entry:post': ['owner', 'accountant'],
      'entry:reverse': ['owner', 'accountant'],
      'period:close': ['owner'],
      'member:manage': ['owner'],
    });
  });

  it('has no permission to delete or update anything', () => {
    // The domain has no such operations. A correction is a reversing entry, and the database
    // refuses an UPDATE or DELETE against history from every role including its owner. A
    // permission for an operation the system cannot perform is a promise it cannot keep, and
    // the first thing anyone would do with it is implement the operation.
    for (const permission of PERMISSIONS) {
      expect(permission).not.toMatch(/delete|update|remove|destroy/i);
    }
  });

  it('names only roles the database can store', () => {
    // book_role is a Postgres enum. A role here that is not in that enum would authorise
    // something no row could ever hold, and would fail at the INSERT rather than here.
    for (const roles of Object.values(POLICY)) {
      for (const role of roles) {
        expect(BOOK_ROLES).toContain(role);
      }
    }
  });

  it('grants every permission to owner', () => {
    // Not a design rule imposed from outside - it happens to be true of the map above, and
    // asserting it means a future permission that owner cannot use has to be argued for.
    for (const permission of PERMISSIONS) {
      expect(can('owner', permission)).toBe(true);
    }
  });
});

describe('can', () => {
  it('lets an accountant post and reverse entries and create accounts', () => {
    expect(can('accountant', 'entry:post')).toBe(true);
    expect(can('accountant', 'entry:reverse')).toBe(true);
    expect(can('accountant', 'account:create')).toBe(true);
    expect(can('accountant', 'book:read')).toBe(true);
  });

  it('stops an accountant short of closing a period or managing members', () => {
    expect(can('accountant', 'period:close')).toBe(false);
    expect(can('accountant', 'member:manage')).toBe(false);
  });

  it('lets a viewer read and nothing else', () => {
    expect(permissionsOf('viewer')).toEqual(['book:read']);
  });

  it('gives an owner everything', () => {
    expect(permissionsOf('owner')).toEqual(PERMISSIONS);
  });
});

describe('the guards', () => {
  it('recognise the permissions and roles that exist', () => {
    expect(isPermission('entry:post')).toBe(true);
    expect(isBookRole('accountant')).toBe(true);
  });

  it('reject anything else, including inherited object properties', () => {
    expect(isPermission('entry:delete')).toBe(false);
    expect(isPermission('toString')).toBe(false);
    expect(isBookRole('admin')).toBe(false);
    expect(isBookRole('')).toBe(false);
  });
});
