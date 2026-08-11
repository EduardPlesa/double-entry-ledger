import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { formatMoney, parseMoney, type Money, type TrialBalanceResource } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';
import { AccountForm } from './AccountForm';
import { buildTree, subtreeTotals, type TreeNode } from './tree';
import { useAccounts } from './useAccounts';

/**
 * The book's accounts as a hierarchy, each with its current balance.
 *
 * Two requests, not one per account: the hierarchy comes from `useAccounts` (which carries
 * `parentId`) and the balances from the trial balance (which does not carry parents). Neither
 * endpoint alone can draw this screen, and the trial balance costs a fixed number of queries
 * regardless of how many accounts a book has - an N+1 in the client would give that away for
 * nothing.
 */
export function AccountTree() {
  const { bookId = '' } = useParams();
  const accounts = useAccounts(bookId);
  const [showClosed, setShowClosed] = useState(true);

  const trialBalance = useQuery({
    queryKey: keys.trialBalance(bookId, null),
    queryFn: () => apiFetch<TrialBalanceResource>(`/books/${bookId}/trial-balance`),
  });

  const balancesById = useMemo(() => {
    const entries = (trialBalance.data?.accounts ?? []).map(
      (line) => [line.accountId, parseMoney(line.balance, line.currency)] as const,
    );
    return new Map<string, Money>(entries);
  }, [trialBalance.data]);

  // The tree is built from every account, closed or not, and the checkbox only controls what
  // `TreeRows` renders. Filtering before `buildTree` would reparent an open child of a hidden
  // closed account onto the root (the orphan rule in `tree.ts`) and drop the closed account's
  // own balance from every ancestor's subtree total - so the hierarchy and the totals would
  // depend on a checkbox that is supposed to be a display toggle, not a data toggle.
  const tree = buildTree(accounts.data ?? []);

  return (
    <main className="mx-auto mt-8 w-[44rem]">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <nav className="flex gap-3 text-sm">
          <Link to={`/books/${bookId}/entries/new`} className="underline">
            New entry
          </Link>
          <Link to={`/books/${bookId}/trial-balance`} className="underline">
            Trial balance
          </Link>
        </nav>
      </div>

      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showClosed}
          onChange={(event) => { setShowClosed(event.target.checked); }}
        />
        Show closed accounts
      </label>

      <ul className="mt-4 flex flex-col gap-1">
        <TreeRows nodes={tree} balancesById={balancesById} showClosed={showClosed} />
      </ul>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Add an account</h2>
        <AccountForm bookId={bookId} />
      </section>
    </main>
  );
}

/**
 * One row per node whose account is either open or shown, plus - unconditionally - every row
 * beneath it. A closed account with the toggle off contributes no `<li>` of its own, but its
 * children render exactly where they would if it were visible: hidden is a display decision
 * about this one row, not about the subtree the row happens to sit above.
 */
function TreeRows({
  nodes,
  balancesById,
  showClosed,
}: {
  nodes: readonly TreeNode[];
  balancesById: ReadonlyMap<string, Money>;
  showClosed: boolean;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.account.closedAt !== null && !showClosed ? (
          <TreeRows key={node.account.id} nodes={node.children} balancesById={balancesById} showClosed={showClosed} />
        ) : (
          <TreeRow key={node.account.id} node={node} balancesById={balancesById} showClosed={showClosed} />
        ),
      )}
    </>
  );
}

function TreeRow({
  node,
  balancesById,
  showClosed,
}: {
  node: TreeNode;
  balancesById: ReadonlyMap<string, Money>;
  showClosed: boolean;
}) {
  const own = balancesById.get(node.account.id);
  // Computed from `node.children` as built (every account, closed or not), never from what is
  // currently rendered - the toggle must not be able to change a subtree total.
  const totals = node.children.length === 0 ? [] : subtreeTotals(node, balancesById);

  return (
    <li className={node.account.closedAt === null ? '' : 'text-gray-400'}>
      <div className="flex items-center justify-between border-b py-1">
        <Link to={`/accounts/${node.account.id}`} className="underline">
          {node.account.name}
        </Link>
        <span className="text-sm">
          <span>{own === undefined ? '' : formatMoney(own)}</span>{' '}
          <span>{node.account.currency}</span>
        </span>
      </div>

      {totals.length === 0 ? null : (
        <p className="pl-4 text-xs text-gray-600">
          including children: {totals.map((total) => `${formatMoney(total)} ${total.currency}`).join(', ')}
        </p>
      )}

      {node.children.length === 0 ? null : (
        <ul className="pl-4">
          <TreeRows nodes={node.children} balancesById={balancesById} showClosed={showClosed} />
        </ul>
      )}
    </li>
  );
}
