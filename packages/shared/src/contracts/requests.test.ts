import { describe, expect, it } from 'vitest';
import {
  createAccountInput,
  listPostingsInput,
  postEntryInput,
  reverseEntryInput,
} from './requests.js';

const ACCOUNT = '3f4d0b7e-9a5e-4c3b-8a52-2c1f5c9a1b23';
const OTHER = '9b1c2d3e-4f50-4a6b-9c8d-7e6f5a4b3c2d';

function leg(overrides: Record<string, unknown> = {}) {
  return { accountId: ACCOUNT, amount: '10.00', currency: 'EUR', ...overrides };
}

describe('postEntryInput', () => {
  it('accepts a two-legged entry and leaves the amounts as strings', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      legs: [leg(), leg({ accountId: OTHER, amount: '-10.00' })],
    });

    expect(result.success).toBe(true);
    expect(result.data?.legs[0]?.amount).toBe('10.00');
  });

  it('coerces occurredAt to a Date, because the caller asserts it as a string', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      legs: [leg(), leg({ accountId: OTHER, amount: '-10.00' })],
    });

    expect(result.data?.occurredAt).toBeInstanceOf(Date);
  });

  it('rejects a single-legged entry with the message the API answers with', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      legs: [leg()],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('an entry needs at least two legs');
  });

  it('rejects a currency that is not three uppercase letters', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      legs: [leg({ currency: 'eur' }), leg({ accountId: OTHER, amount: '-10.00' })],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a blank description', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: '   ',
      legs: [leg(), leg({ accountId: OTHER, amount: '-10.00' })],
    });

    expect(result.success).toBe(false);
  });
});

describe('createAccountInput', () => {
  it('accepts the five account types and nothing else', () => {
    for (const type of ['asset', 'liability', 'equity', 'revenue', 'expense']) {
      expect(createAccountInput.safeParse({ name: 'Cash', type, currency: 'EUR' }).success).toBe(true);
    }

    expect(createAccountInput.safeParse({ name: 'Cash', type: 'goodwill', currency: 'EUR' }).success).toBe(
      false,
    );
  });
});

describe('reverseEntryInput', () => {
  it('accepts an empty object, because a reversal determines its own legs', () => {
    expect(reverseEntryInput.safeParse({}).success).toBe(true);
  });
});

describe('listPostingsInput', () => {
  it('defaults the page size to 50 and coerces a query string', () => {
    expect(listPostingsInput.parse({})).toEqual({ limit: 50 });
    expect(listPostingsInput.parse({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('refuses a page size above the cap', () => {
    expect(listPostingsInput.safeParse({ limit: 201 }).success).toBe(false);
  });
});
