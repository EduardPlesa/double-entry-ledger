import { describe, expect, it } from 'vitest';
import { BOOK_ROLES } from './roles.js';

describe('BOOK_ROLES', () => {
  it('is the three roles the database enum holds, in privilege order', () => {
    expect(BOOK_ROLES).toEqual(['owner', 'accountant', 'viewer']);
  });
});
