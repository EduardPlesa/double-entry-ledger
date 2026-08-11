import { describe, expect, it } from 'vitest';
import { formatMoney, type AccountResource } from '@ledger/shared';
import {
  canSubmit,
  imbalances,
  legProblem,
  remainderFor,
  signedAmount,
  type LegRow,
} from '../../src/entries/legs';

function account(id: string, currency: string): AccountResource {
  return { id, bookId: 'book-1', name: id, type: 'asset', currency, parentId: null, closedAt: null };
}

const ACCOUNTS = new Map([
  ['eur-a', account('eur-a', 'EUR')],
  ['eur-b', account('eur-b', 'EUR')],
  ['usd-a', account('usd-a', 'USD')],
  ['jpy-a', account('jpy-a', 'JPY')],
]);

function row(overrides: Partial<LegRow> = {}): LegRow {
  return { accountId: 'eur-a', debit: '', credit: '', ...overrides };
}

describe('legProblem', () => {
  it('accepts a row with one column filled', () => {
    expect(legProblem(row({ debit: '10.00' }), 'EUR')).toBeNull();
    expect(legProblem(row({ credit: '10.00' }), 'EUR')).toBeNull();
  });

  it('names each way a row can be wrong', () => {
    expect(legProblem(row({ accountId: '', debit: '10.00' }), null)).toBe('no-account');
    expect(legProblem(row({ debit: '10.00', credit: '10.00' }), 'EUR')).toBe('both-columns');
    expect(legProblem(row(), 'EUR')).toBe('no-amount');
    expect(legProblem(row({ debit: 'ten' }), 'EUR')).toBe('unparseable');
    expect(legProblem(row({ debit: '0.00' }), 'EUR')).toBe('zero');
  });

  it('rejects more decimal places than the currency has', () => {
    expect(legProblem(row({ accountId: 'jpy-a', debit: '10.5' }), 'JPY')).toBe('unparseable');
    expect(legProblem(row({ accountId: 'eur-a', debit: '10.005' }), 'EUR')).toBe('unparseable');
  });
});

describe('signedAmount', () => {
  it('makes a debit positive and a credit negative', () => {
    expect(formatMoney(signedAmount(row({ debit: '10.00' }), 'EUR')!)).toBe('10.00');
    expect(formatMoney(signedAmount(row({ credit: '10.00' }), 'EUR')!)).toBe('-10.00');
  });

  it('returns null for a row that is not usable', () => {
    expect(signedAmount(row({ debit: 'ten' }), 'EUR')).toBeNull();
    expect(signedAmount(row(), 'EUR')).toBeNull();
  });
});

describe('imbalances', () => {
  it('reports one delta per currency, including the balanced ones', () => {
    const result = imbalances(
      [
        row({ accountId: 'eur-a', debit: '10.00' }),
        row({ accountId: 'eur-b', credit: '5.80' }),
        row({ accountId: 'usd-a', debit: '3.00' }),
      ],
      ACCOUNTS,
    );

    expect(result.map((entry) => [entry.currency, formatMoney(entry.delta)])).toEqual([
      ['EUR', '4.20'],
      ['USD', '3.00'],
    ]);
  });

  it('is zero for each currency when the entry balances', () => {
    const result = imbalances(
      [
        row({ accountId: 'eur-a', debit: '10.00' }),
        row({ accountId: 'eur-b', credit: '10.00' }),
        row({ accountId: 'usd-a', debit: '3.00' }),
        row({ accountId: 'usd-a', credit: '3.00' }),
      ],
      ACCOUNTS,
    );

    expect(result.map((entry) => formatMoney(entry.delta))).toEqual(['0.00', '0.00']);
  });

  it('never adds across currencies', () => {
    const result = imbalances(
      [row({ accountId: 'eur-a', debit: '10.00' }), row({ accountId: 'usd-a', credit: '10.00' })],
      ACCOUNTS,
    );

    expect(result).toHaveLength(2);
    expect(result.map((entry) => formatMoney(entry.delta))).toEqual(['10.00', '-10.00']);
  });

  it('ignores rows that cannot be read yet, so the strip updates while typing', () => {
    const result = imbalances(
      [row({ accountId: 'eur-a', debit: '10.00' }), row({ accountId: 'eur-b', credit: '' })],
      ACCOUNTS,
    );

    expect(formatMoney(result[0]!.delta)).toBe('10.00');
  });
});

describe('canSubmit', () => {
  const balanced: LegRow[] = [
    row({ accountId: 'eur-a', debit: '10.00' }),
    row({ accountId: 'eur-b', credit: '10.00' }),
  ];

  it('allows a balanced pair', () => {
    expect(canSubmit(balanced, ACCOUNTS)).toBe(true);
  });

  it('refuses fewer than two legs, however balanced', () => {
    expect(canSubmit([row({ debit: '0.00' })], ACCOUNTS)).toBe(false);
  });

  it('refuses an unbalanced entry', () => {
    expect(canSubmit([balanced[0]!, row({ accountId: 'eur-b', credit: '9.00' })], ACCOUNTS)).toBe(false);
  });

  it('refuses when any row is wrong, even if the rest balance', () => {
    expect(canSubmit([...balanced, row({ accountId: 'eur-a' })], ACCOUNTS)).toBe(false);
    expect(canSubmit([...balanced, row({ accountId: '', debit: '1.00' })], ACCOUNTS)).toBe(false);
  });

  it('refuses when one currency balances and another does not', () => {
    expect(canSubmit([...balanced, row({ accountId: 'usd-a', debit: '1.00' })], ACCOUNTS)).toBe(false);
  });
});

describe('remainderFor', () => {
  it('gives the amount that would bring the row\'s currency to zero', () => {
    const rows = [row({ accountId: 'eur-a', debit: '10.00' }), row({ accountId: 'eur-b' })];

    expect(remainderFor(rows, ACCOUNTS, 1)).toBe('10.00');
  });

  it('gives nothing when the currency already balances', () => {
    const rows = [
      row({ accountId: 'eur-a', debit: '10.00' }),
      row({ accountId: 'eur-b', credit: '10.00' }),
      row({ accountId: 'eur-a' }),
    ];

    expect(remainderFor(rows, ACCOUNTS, 2)).toBeNull();
  });

  it('gives nothing for a row with no account, since its currency is unknown', () => {
    expect(remainderFor([row({ accountId: '' })], ACCOUNTS, 0)).toBeNull();
  });
});
