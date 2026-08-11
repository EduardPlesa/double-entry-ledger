import { describe, expect, it } from 'vitest';
import { formatMoney, money, type AccountResource } from '@ledger/shared';
import { buildTree, subtreeTotals } from '../../src/accounts/tree';

function account(id: string, parentId: string | null, currency = 'EUR'): AccountResource {
  return { id, bookId: 'book-1', name: id, type: 'asset', currency, parentId, closedAt: null };
}

describe('buildTree', () => {
  it('nests children under their parent and keeps roots in order', () => {
    const tree = buildTree([account('a', null), account('a1', 'a'), account('b', null)]);

    expect(tree.map((node) => node.account.id)).toEqual(['a', 'b']);
    expect(tree[0]!.children.map((node) => node.account.id)).toEqual(['a1']);
  });

  it('treats an account whose parent is absent as a root, rather than dropping it', () => {
    const tree = buildTree([account('orphan', 'missing')]);

    expect(tree.map((node) => node.account.id)).toEqual(['orphan']);
  });
});

describe('subtreeTotals', () => {
  const balances = new Map([
    ['a', money(1000n, 'EUR')],
    ['a1', money(500n, 'EUR')],
    ['usd', money(300n, 'USD')],
  ]);

  it('sums a subtree per currency', () => {
    const tree = buildTree([account('a', null), account('a1', 'a')]);

    expect(subtreeTotals(tree[0]!, balances).map(formatMoney)).toEqual(['15.00']);
  });

  it('never adds across currencies', () => {
    const tree = buildTree([account('a', null), account('usd', 'a', 'USD')]);
    const totals = subtreeTotals(tree[0]!, balances);

    expect(totals.map((total) => `${total.currency} ${formatMoney(total)}`)).toEqual([
      'EUR 10.00',
      'USD 3.00',
    ]);
  });
});
