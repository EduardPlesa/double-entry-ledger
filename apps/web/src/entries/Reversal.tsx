import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import {
  formatMoney,
  isNegativeMoney,
  parseMoney,
  type EntryResource,
  type Money,
  type TrialBalanceResource,
} from '@ledger/shared';
import { useAccounts } from '../accounts/useAccounts';
import { apiFetch, newIdempotencyKey } from '../api/client';
import { keys } from '../api/keys';
import { useToast } from '../toast/ToastProvider';
import { impactOf } from './impact';

/**
 * A reversal's before/after preview, and the confirmation that posts it.
 *
 * Balances come from the book's trial balance, one request regardless of how many legs the
 * entry has, rather than a balance call per affected account - the same N+1 the account tree
 * avoids for the same reason. The trial balance is keyed on the entry's own `bookId`, so it is
 * only fetched once the entry has loaded, and `enabled` is what makes that ordering real rather
 * than a query that fires with `bookId` undefined and refetches once it isn't. Account names
 * come from the same `useAccounts(bookId)` cache the tree fills, joined on `accountId` - the
 * preview otherwise has nothing but the UUID the posting carries.
 *
 * A projected negative balance is rendered as "the server may refuse this", never as a
 * prediction: reversals are not exempt from the overdraft rule, and that rule is evaluated at
 * commit, against the account's history as it stands at that moment - which another writer may
 * have moved since this preview was drawn. The preview owns the arithmetic; it does not own the
 * outcome.
 *
 * `reversedBy` is why the button can be withheld before a click is ever made: an entry that has
 * already been reversed can only answer `ENTRY_ALREADY_REVERSED`, and there is no reason to
 * discover that by posting when the entry says so up front.
 *
 * On success, four caches are stale: the entry itself (so a caller returning here sees
 * `reversedBy` set rather than re-offering a button that can only fail), the book's accounts
 * and trial balance (so the tree and the report stop showing pre-reversal balances for
 * `staleTime`'s window), and the postings of every account the reversal touched (so account
 * detail's ledger is not missing the reversal's own postings).
 */
export function Reversal() {
  const { entryId = '' } = useParams();
  const { showError } = useToast();
  const queryClient = useQueryClient();
  const [done, setDone] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);

  const entry = useQuery({
    queryKey: keys.entry(entryId),
    queryFn: () => apiFetch<EntryResource>(`/entries/${entryId}`),
  });

  const bookId = entry.data?.bookId;

  const trialBalance = useQuery({
    queryKey: keys.trialBalance(bookId ?? '', null),
    queryFn: () => apiFetch<TrialBalanceResource>(`/books/${bookId ?? ''}/trial-balance`),
    enabled: bookId !== undefined,
  });

  const accounts = useAccounts(bookId ?? '', { enabled: bookId !== undefined });

  const balancesById = useMemo(() => {
    const entries = (trialBalance.data?.accounts ?? []).map(
      (line) => [line.accountId, parseMoney(line.balance, line.currency)] as const,
    );
    return new Map<string, Money>(entries);
  }, [trialBalance.data]);

  const accountNamesById = useMemo(
    () => new Map((accounts.data ?? []).map((account) => [account.id, account.name])),
    [accounts.data],
  );

  const nameFor = (accountId: string): string => accountNamesById.get(accountId) ?? accountId;

  const reverse = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>(`/entries/${entryId}/reverse`, {
        method: 'POST',
        idempotencyKey,
        body: {},
      }),
    onSuccess: async () => {
      setDone(true);

      const affectedAccountIds = entry.data?.postings.map((posting) => posting.accountId) ?? [];

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.entry(entryId) }),
        ...(bookId === undefined
          ? []
          : [
              queryClient.invalidateQueries({ queryKey: keys.accounts(bookId) }),
              queryClient.invalidateQueries({ queryKey: keys.trialBalance(bookId, null) }),
            ]),
        ...affectedAccountIds.map((accountId) =>
          queryClient.invalidateQueries({ queryKey: keys.postings(accountId) }),
        ),
      ]);
    },
    onError: showError,
  });

  if (entry.data === undefined) return <main className="p-8">Loading…</main>;

  const impact = impactOf(entry.data, balancesById);
  const negative = impact.filter((line) => isNegativeMoney(line.after));

  return (
    <main className="mx-auto mt-8 w-[44rem]">
      <h1 className="text-2xl font-semibold">Reverse this entry</h1>
      <p className="mt-1 text-sm text-gray-600">{entry.data.description}</p>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">Account</th>
            <th className="text-right">Before</th>
            <th className="text-right">Change</th>
            <th className="text-right">After</th>
          </tr>
        </thead>
        <tbody>
          {impact.map((line) => (
            <tr key={line.accountId}>
              <td>{nameFor(line.accountId)}</td>
              <td className="text-right">{formatMoney(line.before)}</td>
              <td className="text-right">{formatMoney(line.delta)}</td>
              <td className="text-right">{formatMoney(line.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {negative.length === 0 ? null : (
        <p className="mt-4 border border-amber-400 p-3 text-sm">
          {negative.map((line) => nameFor(line.accountId)).join(', ')} would go negative. If{' '}
          {negative.length === 1 ? 'that account is' : 'any of those accounts is'} guarded, the
          server may refuse this reversal - and it decides against the book as it stands at that
          moment, which another writer may have moved since this preview was drawn.
        </p>
      )}

      {entry.data.reversedBy !== null ? (
        <p className="mt-4 text-sm">This entry is already reversed.</p>
      ) : done ? (
        <p className="mt-4 text-sm">Entry reversed.</p>
      ) : (
        <button
          type="button"
          onClick={() => { reverse.mutate(); }}
          disabled={reverse.isPending}
          className="mt-4 border p-2"
        >
          Reverse this entry
        </button>
      )}
    </main>
  );
}
