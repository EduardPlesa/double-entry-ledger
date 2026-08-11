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

  const [outcome, setOutcome] = useState<'created' | null>(null);
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<number, string>>(new Map());

  // The key and the instant it is posted at are minted together and held across retries - but
  // "held across retries" is only true while a retry sends the exact same body. `occurredAt` is
  // frozen here rather than read fresh in `mutationFn`, because the API fingerprints the raw
  // request body and compares it *before* it decides whether a stored response is replayable: a
  // held key arriving with a body that changed (even just the timestamp) is a different request
  // wearing the first one's key, and the server answers a permanent 409 rather than a retry.
  //
  // The pair is rotated in exactly two situations. Once something is actually recorded
  // (`onSuccess`, below) - a new entry deserves a key of its own. And on the first edit to the
  // form after a failed attempt (`attemptFailed`, tracked below) - a form the user has since
  // changed is no longer the request the held key was minted for, and holding it across that
  // edit would either replay the old failure's answer or throw `IDEMPOTENCY_KEY_REUSED` against
  // a body that no longer matches. `attemptFailed` is what makes that a one-shot: it is cleared
  // by the first edit that consumes it, so typing further does not mint a key per keystroke.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString());
  const [attemptFailed, setAttemptFailed] = useState(false);

  const rotateKeyIfStale = () => {
    if (!attemptFailed) return;
    setAttemptFailed(false);
    setIdempotencyKey(newIdempotencyKey());
    setOccurredAt(new Date().toISOString());
  };

  const post = useMutation({
    mutationFn: async () => {
      const legs = rows.map((row) => {
        const currency = currencyOf(row, accountsById);
        const amount = currency === null ? null : signedAmount(row, currency);

        // `ready` already proved every row is usable; this is the type narrowing, not a check.
        if (currency === null || amount === null) throw new Error('a leg was not ready to send');

        return { accountId: row.accountId, amount: formatMoney(amount), currency };
      });

      await apiFetch<{ id: string }>(`/books/${bookId}/entries`, {
        method: 'POST',
        idempotencyKey,
        body: { occurredAt, description: description.trim(), legs },
      });

      // Every account this entry touched, for the postings invalidation below - collected here
      // because `rows` is reset to empty in `onSuccess` before that invalidation runs.
      return { accountIds: [...new Set(legs.map((leg) => leg.accountId))] };
    },
    onSuccess: async ({ accountIds }) => {
      setRowErrors(new Map());
      setOutcome('created');
      setAttemptFailed(false);
      setIdempotencyKey(newIdempotencyKey());
      setOccurredAt(new Date().toISOString());
      setRows([EMPTY_ROW, EMPTY_ROW]);
      setDescription('');

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.trialBalance(bookId, null) }),
        queryClient.invalidateQueries({ queryKey: keys.accounts(bookId) }),
        ...accountIds.map((accountId) =>
          queryClient.invalidateQueries({ queryKey: keys.postings(accountId) }),
        ),
      ]);
    },
    onError: (error: unknown) => {
      const fields = fieldErrorsByRow(error);
      setRowErrors(fields);
      setAttemptFailed(true);
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
    rotateKeyIfStale();
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

  const addLeg = () => {
    rotateKeyIfStale();
    setRows((current) => [...current, EMPTY_ROW]);
  };

  const removeLeg = (index: number) => {
    rotateKeyIfStale();
    setRows((current) => current.filter((_, position) => position !== index));
  };

  return (
    <main className="mx-auto mt-8 w-[52rem]">
      <h1 className="text-2xl font-semibold">New entry</h1>

      <label className="mt-4 flex flex-col gap-1">
        Description
        <input
          value={description}
          onChange={(event) => { rotateKeyIfStale(); setDescription(event.target.value); }}
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
              onRemove={rows.length > 2 ? () => { removeLeg(index); } : null}
            />
          ))}
        </tbody>
      </table>

      <button type="button" onClick={addLeg} className="mt-2 border p-2 text-sm">
        Add leg
      </button>

      <ImbalanceStrip deltas={deltas} />

      <button
        type="button"
        disabled={!ready || post.isPending}
        onClick={() => { setOutcome(null); post.mutate(); }}
        className="mt-4 border p-2 disabled:opacity-50"
      >
        Post entry
      </button>

      {outcome === 'created' ? <p className="mt-2 text-sm">Entry recorded.</p> : null}
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
