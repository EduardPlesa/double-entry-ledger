import { describe, expect, it } from 'vitest';
import { formatMoney, money, type EntryResource } from '@ledger/shared';
import { impactOf } from '../../src/entries/impact';

const entry: EntryResource = {
  id: 'entry-1',
  bookId: 'book-1',
  occurredAt: '2026-03-01T12:00:00.000Z',
  recordedAt: '2026-03-01T12:00:00.000Z',
  description: 'a sale',
  externalId: null,
  reversalOf: null,
  reversedBy: null,
  postings: [
    { id: '1', accountId: 'acc-cash', amount: '10.00', currency: 'EUR' },
    { id: '2', accountId: 'acc-sales', amount: '-10.00', currency: 'EUR' },
  ],
};

describe('impactOf', () => {
  it('negates each leg and applies it to the current balance', () => {
    const balances = new Map([
      ['acc-cash', money(120000n, 'EUR')],
      ['acc-sales', money(-5000n, 'EUR')],
    ]);

    const impact = impactOf(entry, balances);

    expect(impact.map((line) => [line.accountId, formatMoney(line.before), formatMoney(line.delta), formatMoney(line.after)])).toEqual([
      ['acc-cash', '1200.00', '-10.00', '1190.00'],
      ['acc-sales', '-50.00', '10.00', '-40.00'],
    ]);
  });

  it('treats an account with no reported balance as zero', () => {
    const impact = impactOf(entry, new Map());

    expect(formatMoney(impact[0]!.after)).toBe('-10.00');
  });
});
