import { describe, expect, it } from 'vitest';
import { isUuid, newId } from './id.js';

describe('newId', () => {
  it('produces a well-formed uuid', () => {
    expect(isUuid(newId())).toBe(true);
  });

  it('produces distinct values', () => {
    const ids = new Set(Array.from({ length: 1000 }, newId));
    expect(ids.size).toBe(1000);
  });

  it('sets the version nibble to 7', () => {
    // Character 14 is the version. This is what buys the index locality; if a future
    // change swapped in v4, everything would still pass a format check but the write
    // path would silently regress.
    expect(newId()[14]).toBe('7');
  });

  it('sorts lexicographically in creation order', () => {
    const ids = Array.from({ length: 500 }, newId);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('isUuid', () => {
  it.for([
    ['', false],
    ['not-a-uuid', false],
    ['0189d6f1-8a4e-7c3e-9b2a-1f4c5d6e7f80', true],
    ['0189D6F1-8A4E-7C3E-9B2A-1F4C5D6E7F80', true],
    ['0189d6f1-8a4e-7c3e-9b2a-1f4c5d6e7f8', false],
    ['0189d6f1-8a4e-7c3e-9b2a-1f4c5d6e7f800', false],
  ] as const)('%s -> %s', ([input, expected]) => {
    expect(isUuid(input)).toBe(expected);
  });
});
