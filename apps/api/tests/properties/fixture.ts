import { formatMoney, money } from '@ledger/shared';
import type { Pool } from 'pg';
import { isGuardedAccountType } from '../../src/domain/overdraft.js';
import type { AccountRecord } from '../../src/repositories/ledger.repository.js';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { seedBookIn, type Book } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * A funded book, one per generated case.
 *
 * Funded because an empty book exercises one branch of the overdraft rule and nothing else:
 * every withdrawal from a zero balance is refused, the coverage guard fires, and the sequence
 * proves nothing. Every guarded account opens with €1,000.00 - or its currency's equivalent -
 * dated before any generated entry, so history is well-founded before anything draws on it.
 *
 * A fresh book per case rather than a shared one, because this database has no teardown by
 * design: entries and postings cannot be deleted. Isolation is disjointness.
 */

export const OPENING_MINOR = 100_000n;
export const OPENING_AT = '2026-01-01T00:00:00.000Z';

export interface PropertyBook {
  readonly bookId: string;
  readonly accounts: readonly AccountRecord[];
  readonly service: LedgerService;
}

export async function createPropertyBook(pool: Pool): Promise<PropertyBook> {
  const { service } = createService(pool);
  const book = await seedBookIn(pool);
  const records = accountsOf(book);

  // One opening entry per currency: every guarded account in it funded, the counterpart on an
  // unguarded account of the same currency so the entry balances without going short.
  const currencies = [...new Set(records.map((account) => account.currency))].sort();

  for (const currency of currencies) {
    const inCurrency = records.filter((account) => account.currency === currency);
    const guarded = inCurrency.filter((account) => isGuardedAccountType(account.type));
    const counterpart = inCurrency.find((account) => !isGuardedAccountType(account.type));

    if (guarded.length === 0 || counterpart === undefined) continue;

    await service.postEntry(book.bookId, {
      occurredAt: OPENING_AT,
      description: `opening balance ${currency}`,
      legs: [
        ...guarded.map((account) => ({
          accountId: account.id,
          amount: formatMoney(money(OPENING_MINOR, currency)),
          currency,
        })),
        {
          accountId: counterpart.id,
          amount: formatMoney(money(-OPENING_MINOR * BigInt(guarded.length), currency)),
          currency,
        },
      ],
    });
  }

  return { bookId: book.bookId, accounts: records, service };
}

/**
 * The fixture's accounts as records, without a round trip to read back what we just wrote.
 *
 * `seedBook` creates exactly these six and nothing closes them, so the shape is known. A query
 * here would be a query against `accounts` needing its own book-scoped transaction, to learn
 * what the helper that created them already knows.
 */
function accountsOf(book: Book): AccountRecord[] {
  const record = (
    id: string,
    name: string,
    type: AccountRecord['type'],
    currency: string,
  ): AccountRecord => ({ id, bookId: book.bookId, name, type, currency, closedAt: null });

  return [
    record(book.cash, 'Cash', 'asset', 'EUR'),
    record(book.bank, 'Bank', 'asset', 'EUR'),
    record(book.sales, 'Sales', 'revenue', 'EUR'),
    record(book.rent, 'Rent', 'expense', 'EUR'),
    record(book.cashUsd, 'Cash USD', 'asset', 'USD'),
    record(book.salesUsd, 'Sales USD', 'revenue', 'USD'),
  ];
}
