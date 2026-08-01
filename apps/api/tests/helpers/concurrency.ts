import type { Pool } from 'pg';
import type { LedgerService, PostEntryInput } from '../../src/services/ledger.service.js';
import { seedBookIn, type Book } from './ledger.js';

/**
 * Fixtures for the concurrency tests.
 *
 * Everything here works in whole euros and fires real transactions through a real pool. A
 * fake would be worse than useless: the entire question is what two Postgres transactions do
 * to each other, and the answer is not a property of this process.
 */

/** A book whose `cash` account holds `amountMinor`, committed before anything races. */
export async function fundedBook(
  pool: Pool,
  service: LedgerService,
  amountMinor: bigint,
): Promise<Book> {
  const book = await seedBookIn(pool);

  await service.postEntry(book.bookId, {
    occurredAt: '2026-01-01T00:00:00.000Z',
    description: 'opening balance',
    legs: [
      { accountId: book.cash, amount: decimal(amountMinor), currency: 'EUR' },
      { accountId: book.sales, amount: decimal(-amountMinor), currency: 'EUR' },
    ],
  });

  return book;
}

/** One withdrawal from `cash`. Each is individually affordable; together they are not. */
export function withdrawal(book: Book, amountMinor: bigint, index: number): PostEntryInput {
  return {
    occurredAt: '2026-02-01T00:00:00.000Z',
    description: `concurrent withdrawal ${index.toString()}`,
    legs: [
      { accountId: book.cash, amount: decimal(-amountMinor), currency: 'EUR' },
      { accountId: book.rent, amount: decimal(amountMinor), currency: 'EUR' },
    ],
  };
}

/**
 * Fires `count` withdrawals at once and reports how each ended.
 *
 * Rejections are expected and are not failures: the rule is supposed to refuse some of them.
 * What the caller asserts on is the balance afterwards.
 */
export async function fireConcurrently(
  service: LedgerService,
  book: Book,
  count: number,
  amountMinor: bigint,
): Promise<{ accepted: number; rejected: number; errors: unknown[] }> {
  const attempts = Array.from({ length: count }, (_, index) =>
    service.postEntry(book.bookId, withdrawal(book, amountMinor, index)),
  );

  const settled = await Promise.allSettled(attempts);

  return {
    accepted: settled.filter((result) => result.status === 'fulfilled').length,
    rejected: settled.filter((result) => result.status === 'rejected').length,
    errors: settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
  };
}

/** Minor units as the decimal string the service's input schema expects. €12.34 from 1234n. */
function decimal(amountMinor: bigint): string {
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  const units = absolute / 100n;
  const cents = absolute % 100n;

  return `${negative ? '-' : ''}${units.toString()}.${cents.toString().padStart(2, '0')}`;
}
