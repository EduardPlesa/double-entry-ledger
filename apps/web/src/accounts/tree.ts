import { sumMoney, type AccountResource, type Money } from '@ledger/shared';

/**
 * The hierarchy, from the flat list the API returns.
 *
 * `parentId` is the only thing that makes this a tree, which is why plan 1 added it to
 * `AccountResource` - the trial balance carries balances but not parents, so neither endpoint
 * alone can draw this screen.
 */

export interface TreeNode {
  readonly account: AccountResource;
  readonly children: TreeNode[];
}

export function buildTree(accounts: readonly AccountResource[]): TreeNode[] {
  const nodes = new Map(accounts.map((account) => [account.id, { account, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];

  for (const node of nodes.values()) {
    const parentId = node.account.parentId;
    const parent = parentId === null ? undefined : nodes.get(parentId);

    // An account whose parent is not in this list is shown as a root rather than hidden. The
    // API cannot produce one - a parent must live in the same book - but a screen that silently
    // drops rows is worse than one that shows an odd hierarchy.
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  return roots;
}

/**
 * The subtree's balance, one total per currency.
 *
 * Per currency because a parent may hold accounts denominated differently, and the sum of a EUR
 * balance and a USD one is a number that means nothing. Two currencies produce two lines.
 */
export function subtreeTotals(node: TreeNode, balancesById: ReadonlyMap<string, Money>): Money[] {
  const byCurrency = new Map<string, Money[]>();

  const walk = (current: TreeNode): void => {
    const balance = balancesById.get(current.account.id);
    if (balance !== undefined) {
      byCurrency.set(balance.currency, [...(byCurrency.get(balance.currency) ?? []), balance]);
    }

    for (const child of current.children) walk(child);
  };

  walk(node);

  return [...byCurrency]
    .map(([currency, amounts]) => sumMoney(amounts, currency))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}
