import { describe, expect, it } from 'vitest';
import { accountType } from '../../src/db/schema.js';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import { GUARDED_ACCOUNT_TYPES, isGuardedAccountType } from '../../src/domain/overdraft.js';

describe('guarded account types', () => {
  it('guards assets and nothing else', () => {
    expect([...GUARDED_ACCOUNT_TYPES]).toEqual(['asset']);
    expect(isGuardedAccountType('asset')).toBe(true);

    for (const type of ['liability', 'equity', 'revenue', 'expense'] as const) {
      expect(isGuardedAccountType(type)).toBe(false);
    }
  });
});

describe('AccountOverdrawnError', () => {
  it('names the account, the shortfall and when it happens', () => {
    const error = new AccountOverdrawnError(
      'acct-1',
      { currency: 'EUR', amountMinor: -250n },
      new Date('2026-03-01T12:00:00.000Z'),
    );

    expect(error.code).toBe('ACCOUNT_OVERDRAWN');
    expect(error.message).toContain('acct-1');
    expect(error.message).toContain('-250');
    expect(error.message).toContain('2026-03-01T12:00:00.000Z');
  });

  it('says the database caught it when there is no detail', () => {
    const error = new AccountOverdrawnError('acct-1', null, null);

    expect(error.shortfall).toBeNull();
    expect(error.message).toContain('at COMMIT');
  });
});

describe('AccountType', () => {
  it('lists exactly the values of the account_type enum', () => {
    expect([...GUARDED_ACCOUNT_TYPES].every((type) => accountType.enumValues.includes(type))).toBe(
      true,
    );
    expect([...accountType.enumValues].sort()).toEqual(
      ['asset', 'equity', 'expense', 'liability', 'revenue'].sort(),
    );
  });
});
