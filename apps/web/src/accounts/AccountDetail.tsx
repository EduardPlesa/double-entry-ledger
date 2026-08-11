import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { BalanceResource, PostingPageResource } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';

/**
 * An account's postings, paged by cursor, each with the running balance after it.
 *
 * The running balance is the server's column, rendered as received. Recomputing it here would
 * create a second authority on the `(occurred_at, id)` ordering - the same ordering the API's
 * property suite checks twice, once through a SQL window function and once through an array
 * scan, precisely because that tiebreaker is where a disagreement would hide.
 *
 * Pagination is a keyset cursor, not an offset: `nextCursor` from one page is the `cursor` query
 * parameter of the next, and a `null` cursor means there are no more. `getNextPageParam` returns
 * exactly that value, so `useInfiniteQuery` never needs to know what a cursor means.
 */
export function AccountDetail() {
  const { accountId = '' } = useParams();

  const balance = useQuery({
    queryKey: keys.balance(accountId, null),
    queryFn: () => apiFetch<BalanceResource>(`/accounts/${accountId}/balance`),
  });

  const postings = useInfiniteQuery({
    queryKey: keys.postings(accountId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiFetch<PostingPageResource>(
        `/accounts/${accountId}/postings${pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`}`,
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const items = (postings.data?.pages ?? []).flatMap((page) => page.items);

  return (
    <main className="mx-auto mt-8 w-[52rem]">
      <h1 className="text-2xl font-semibold">Account</h1>

      <p className="mt-2 text-sm">
        Balance: <span className="font-semibold">{balance.data?.balance ?? '—'}</span>{' '}
        {balance.data?.currency ?? ''}
      </p>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">Date</th>
            <th className="text-left">Description</th>
            <th className="text-right">Amount</th>
            <th className="text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.occurredAt.slice(0, 10)}</td>
              <td>
                <Link to={`/entries/${item.entryId}/reverse`} className="underline">
                  {item.description}
                </Link>
              </td>
              <td className="text-right">{item.amount}</td>
              <td className="text-right">{item.runningBalance}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {postings.hasNextPage ? (
        <button
          type="button"
          onClick={() => { void postings.fetchNextPage(); }}
          disabled={postings.isFetchingNextPage}
          className="mt-4 border p-2 text-sm"
        >
          Load more
        </button>
      ) : null}
    </main>
  );
}
