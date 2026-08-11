import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { formatMoney, negateMoney, type AccountResource, type Money } from '@ledger/shared';
import { useAccounts } from '../accounts/useAccounts';
import {
  canSubmit,
  imbalances,
  remainderColumn,
  remainderFor,
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

      <button type="submit" disabled={!ready} className="mt-4 border p-2 disabled:opacity-50">
        Post entry
      </button>
    </main>
  );
}

function LegFields({
  row,
  accounts,
  onChange,
  onBalance,
  onRemove,
}: {
  row: LegRow;
  accounts: readonly AccountResource[];
  onChange: (patch: Partial<LegRow>) => void;
  onBalance: () => void;
  onRemove: (() => void) | null;
}) {
  return (
    <tr>
      <td>
        <select
          aria-label="Account"
          value={row.accountId}
          onChange={(event) => { onChange({ accountId: event.target.value }); }}
          className="w-full border p-1"
        >
          <option value="">Choose an account</option>
          {accounts.map((account) => (
            // Currency lives on `title`, not in the visible label: an option's currency is the
            // same fact the imbalance strip states per currency, and a form with two EUR
            // accounts would otherwise print "EUR" once per option as well as once in the
            // strip, which is noise rather than a second source of truth.
            <option
              key={account.id}
              value={account.id}
              title={account.currency}
              disabled={account.closedAt !== null}
            >
              {account.name}
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
 * One line per currency, because zero-sum is per currency. Two currencies produce two lines and
 * never one sum: adding EUR to USD produces a number that means nothing.
 */
function ImbalanceStrip({ deltas }: { deltas: readonly { currency: string; delta: Money }[] }) {
  if (deltas.length === 0) return null;

  return (
    <ul className="mt-4 flex flex-col gap-1 text-sm">
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
