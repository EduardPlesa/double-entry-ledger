import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatMoney, negateMoney, type AccountResource, type Money } from '@ledger/shared';
import { useAccounts } from '../accounts/useAccounts';
import { apiFetch, newIdempotencyKey } from '../api/client';
import { ApiError } from '../api/problem';
import { keys } from '../api/keys';
import { useToast } from '../toast/ToastProvider';
import {
  canSubmit,
  currencyOf,
  imbalances,
  remainderColumn,
  remainderFor,
  signedAmount,
  type LegRow,
} from './legs';

/**
 * Where entries are written.
 *
 * The strip above the button is the whole point: the imbalance is stated in words and in money
 * as legs are typed, per currency, and submit is impossible until every currency is zero. The
 * database enforces the same rule in a deferred trigger, so this is a courtesy rather than the
 * enforcement - but it is the difference between a form that teaches double-entry and one that
 * rejects you after a round trip.
 *
 * A leg's currency is not an input. An account holds exactly one currency, which
 * `accounts_id_book_id_currency_key` makes a fact about the database, so choosing the account
 * chooses the currency.
 */

const EMPTY_ROW: LegRow = { accountId: '', debit: '', credit: '' };

export function Composer() {
  const { bookId = '' } = useParams();
  const accounts = useAccounts(bookId);

  const [rows, setRows] = useState<LegRow[]>([EMPTY_ROW, EMPTY_ROW]);
  const [description, setDescription] = useState('');

  const accountsData = accounts.data;
  const accountsById = useMemo(
    () => new Map((accountsData ?? []).map((account) => [account.id, account])),
    [accountsData],
  );

  const deltas = imbalances(rows, accountsById);
  const ready = canSubmit(rows, accountsById) && description.trim() !== '';

  const queryClient = useQueryClient();
  const { showError } = useToast();

  const [outcome, setOutcome] = useState<'created' | 'existing' | null>(null);
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<number, string>>(new Map());

  // Minted once per composer session and held across retries. A retry that mints a new key is
  // not a retry, it is a second entry - which is the exact failure the header exists to
  // prevent. A new key is taken only after something is actually recorded.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const post = useMutation({
    mutationFn: async () => {
      const legs = rows.map((row) => {
        const currency = currencyOf(row, accountsById);
        const amount = currency === null ? null : signedAmount(row, currency);

        // `ready` already proved every row is usable; this is the type narrowing, not a check.
        if (currency === null || amount === null) throw new Error('a leg was not ready to send');

        return { accountId: row.accountId, amount: formatMoney(amount), currency };
      });

      return apiFetch<{ id: string }>(`/books/${bookId}/entries`, {
        method: 'POST',
        idempotencyKey,
        body: { occurredAt: new Date().toISOString(), description: description.trim(), legs },
        onStatus: (status) => { setOutcome(status === 200 ? 'existing' : 'created'); },
      });
    },
    onSuccess: async () => {
      setRowErrors(new Map());
      setIdempotencyKey(newIdempotencyKey());
      setRows([EMPTY_ROW, EMPTY_ROW]);
      setDescription('');

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.trialBalance(bookId, null) }),
        queryClient.invalidateQueries({ queryKey: keys.accounts(bookId) }),
      ]);
    },
    onError: (error: unknown) => {
      const fields = fieldErrorsByRow(error);
      setRowErrors(fields);
      if (fields.size === 0) showError(error);
    },
  });

  // Rendered rows and the accounts they can pick from must arrive together: a heading that
  // shows before the account list does would let a caller select an account that isn't in the
  // `<select>` yet, so the loading state gates the whole form rather than just the picker.
  if (accounts.isPending) {
    return (
      <main className="mx-auto mt-8 w-[52rem]">
        <p>Loading…</p>
      </main>
    );
  }

  const update = (index: number, patch: Partial<LegRow>) => {
    setRows((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  };

  const balanceOnto = (index: number) => {
    const amount = remainderFor(rows, accountsById, index);
    const column = remainderColumn(rows, accountsById, index);
    if (amount === null || column === null) return;

    update(index, column === 'debit' ? { debit: amount, credit: '' } : { credit: amount, debit: '' });
  };

  return (
    <main className="mx-auto mt-8 w-[52rem]">
      <h1 className="text-2xl font-semibold">New entry</h1>

      <label className="mt-4 flex flex-col gap-1">
        Description
        <input
          value={description}
          onChange={(event) => { setDescription(event.target.value); }}
          className="border p-2"
        />
      </label>

      <table className="mt-6 w-full">
        <thead>
          <tr>
            <th className="text-left">Account</th>
            <th className="text-right">Debit</th>
            <th className="text-right">Credit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <LegFields
              // The index is the identity here: rows have no id of their own, and reordering
              // is not an operation this form offers.
              key={index}
              row={row}
              accounts={accountsData ?? []}
              currency={currencyOf(row, accountsById)}
              error={rowErrors.get(index)}
              onChange={(patch) => { update(index, patch); }}
              onBalance={() => { balanceOnto(index); }}
              onRemove={rows.length > 2 ? () => { setRows((current) => current.filter((_, p) => p !== index)); } : null}
            />
          ))}
        </tbody>
      </table>

      <button
        type="button"
        onClick={() => { setRows((current) => [...current, EMPTY_ROW]); }}
        className="mt-2 border p-2 text-sm"
      >
        Add leg
      </button>

      <ImbalanceStrip deltas={deltas} />

      <button
        type="button"
        disabled={!ready || post.isPending}
        onClick={() => { post.mutate(); }}
        className="mt-4 border p-2 disabled:opacity-50"
      >
        Post entry
      </button>

      {outcome === 'created' ? <p className="mt-2 text-sm">Entry recorded.</p> : null}
      {outcome === 'existing' ? (
        <p className="mt-2 text-sm">An entry with that external id was already recorded.</p>
      ) : null}
    </main>
  );
}

function LegFields({
  row,
  accounts,
  currency,
  error,
  onChange,
  onBalance,
  onRemove,
}: {
  row: LegRow;
  accounts: readonly AccountResource[];
  currency: string | null;
  error?: string | undefined;
  onChange: (patch: Partial<LegRow>) => void;
  onBalance: () => void;
  onRemove: (() => void) | null;
}) {
  return (
    <tr>
      <td>
        {error === undefined ? null : <p className="text-xs text-red-600">{error}</p>}
        <select
          aria-label="Account"
          value={row.accountId}
          onChange={(event) => { onChange({ accountId: event.target.value }); }}
          className="w-full border p-1"
        >
          <option value="">Choose an account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id} disabled={account.closedAt !== null}>
              {account.name} ({account.currency})
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          aria-label="Debit"
          value={row.debit}
          onChange={(event) => { onChange({ debit: event.target.value }); }}
          className="w-full border p-1 text-right"
        />
      </td>
      <td>
        <input
          aria-label="Credit"
          value={row.credit}
          onChange={(event) => { onChange({ credit: event.target.value }); }}
          className="w-full border p-1 text-right"
        />
      </td>
      <td className="whitespace-nowrap text-sm">
        <span className="mr-2 text-gray-500">{currency ?? ''}</span>
        <button type="button" onClick={onBalance} className="underline">
          Balance
        </button>
        {onRemove === null ? null : (
          <button type="button" onClick={onRemove} className="ml-2 underline">
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * `legs.3.amount` becomes row 3.
 *
 * The server validates a list of legs; the form renders a table of rows, and they are the same
 * list in the same order. Anything not shaped like a leg path is left for the toast.
 */
function fieldErrorsByRow(error: unknown): ReadonlyMap<number, string> {
  if (!(error instanceof ApiError)) return new Map();

  const byRow = new Map<number, string>();

  for (const detail of error.errors) {
    const match = /^legs\.(\d+)\./.exec(detail.path);
    if (match?.[1] === undefined) continue;

    byRow.set(Number(match[1]), detail.message);
  }

  return byRow;
}

/**
 * One line per currency, because zero-sum is per currency. Two currencies produce two lines and
 * never one sum: adding EUR to USD produces a number that means nothing.
 */
function ImbalanceStrip({ deltas }: { deltas: readonly { currency: string; delta: Money }[] }) {
  if (deltas.length === 0) return null;

  return (
    <ul aria-label="Imbalance" className="mt-4 flex flex-col gap-1 text-sm">
      {deltas.map((entry) => (
        <li key={entry.currency}>
          <span className="font-semibold">{entry.currency}</span>{' '}
          {entry.delta.amountMinor === 0n ? (
            <span>balanced</span>
          ) : entry.delta.amountMinor > 0n ? (
            <span>debits exceed credits by {formatMoney(entry.delta)}</span>
          ) : (
            <span>credits exceed debits by {formatMoney(negateMoney(entry.delta))}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
