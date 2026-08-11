import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import type { TrialBalanceResource } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';

/**
 * The book's trial balance: every account's balance, grouped by type, plus the per-currency
 * debit/credit totals that prove the book balances.
 *
 * `asOf` lives in the query string rather than component state, so a particular view - "the
 * trial balance as of last March" - is a link someone can send, not a click path they have to
 * repeat. It is forwarded to `keys.trialBalance` unchanged, so two different `asOf` values are
 * two cache entries rather than one that flickers between them while a request is in flight.
 *
 * Accounts stay in the order the server sent them - by type, then name - and headings are
 * inserted while walking that list. `serialize.ts` documents that ordering as existing for
 * exactly this: re-sorting or re-grouping here would throw that away for nothing.
 */
export function TrialBalance() {
  const { bookId = '' } = useParams();
  const [search] = useSearchParams();
  const asOf = search.get('asOf');

  const report = useQuery({
    queryKey: keys.trialBalance(bookId, asOf),
    queryFn: () =>
      apiFetch<TrialBalanceResource>(
        `/books/${bookId}/trial-balance${asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`}`,
      ),
  });

  const lines = report.data?.accounts ?? [];

  return (
    <main className="mx-auto mt-8 w-[44rem]">
      <h1 className="text-2xl font-semibold">Trial balance</h1>
      {asOf === null ? null : <p className="text-sm text-gray-600">as of {asOf}</p>}

      {report.data?.balanced === false ? (
        <p role="alert" className="mt-4 border border-red-400 p-3">
          This book does not balance. Every entry sums to zero by construction, so this means
          something has written to the database outside the ledger.
        </p>
      ) : null}

      <table className="mt-6 w-full text-sm">
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.accountId}>
              <td>
                {index === 0 || lines[index - 1]?.type !== line.type ? (
                  <span className="block pt-3 font-semibold uppercase">{line.type}</span>
                ) : null}
                {line.name}
              </td>
              <td className="text-right text-gray-500">
                {line.balance} {line.currency}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">Currency</th>
            <th className="text-right">Debits</th>
            <th className="text-right">Credits</th>
          </tr>
        </thead>
        <tbody>
          {(report.data?.totals ?? []).map((total) => (
            <tr key={total.currency}>
              <td>{total.currency}</td>
              <td className="text-right">{total.debits}</td>
              <td className="text-right">{total.credits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
