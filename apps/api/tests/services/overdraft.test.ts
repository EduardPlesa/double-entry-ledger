import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import type { LedgerService, PostEntryInput } from '../../src/services/ledger.service.js';
import { seedBookIn, type Book } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * The overdraft rule, single-threaded. Concurrency is `tests/concurrency/` - these are about
 * what the rule *means*, and the backdating cases are the ones that distinguish it from the
 * obvious "current balance must not be negative" reading.
 */

let pool: Pool;
let service: LedgerService;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 6 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

/** A fresh book, so each test's history is its own. */
async function freshBook(): Promise<Book> {
  return seedBookIn(pool);
}

/** Money into an account from revenue. Positive on the account. */
function deposit(book: Book, accountId: string, amount: string, occurredAt: string): PostEntryInput {
  return {
    occurredAt,
    description: `deposit ${amount}`,
    legs: [
      { accountId, amount, currency: 'EUR' },
      { accountId: book.sales, amount: `-${amount}`, currency: 'EUR' },
    ],
  };
}

/** Money out of an account into an expense. Negative on the account. */
function withdrawal(
  book: Book,
  accountId: string,
  amount: string,
  occurredAt: string,
): PostEntryInput {
  return {
    occurredAt,
    description: `withdrawal ${amount}`,
    legs: [
      { accountId, amount: `-${amount}`, currency: 'EUR' },
      { accountId: book.rent, amount, currency: 'EUR' },
    ],
  };
}

describe('an asset account may not go negative', () => {
  it('rejects a withdrawal larger than the balance', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-01-01T00:00:00.000Z'));

    await expect(
      service.postEntry(book.bookId, withdrawal(book, book.cash, '15.00', '2026-02-01T00:00:00.000Z')),
    ).rejects.toThrow(AccountOverdrawnError);
  });

  it('names the account, the shortfall and the moment', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-01-01T00:00:00.000Z'));

    const error = await service
      .postEntry(book.bookId, withdrawal(book, book.cash, '15.00', '2026-02-01T00:00:00.000Z'))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AccountOverdrawnError);
    const overdrawn = error as AccountOverdrawnError;
    expect(overdrawn.accountId).toBe(book.cash);
    expect(overdrawn.shortfall).toEqual({ currency: 'EUR', amountMinor: -500n });
    expect(overdrawn.occurredAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('accepts a withdrawal that lands exactly on zero', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-01-01T00:00:00.000Z'));

    const result = await service.postEntry(
      book.bookId,
      withdrawal(book, book.cash, '10.00', '2026-02-01T00:00:00.000Z'),
    );

    expect(result.created).toBe(true);
  });

  it('leaves unguarded types alone', async () => {
    const book = await freshBook();

    // Revenue going negative is ordinary: that is what a credit balance is.
    const result = await service.postEntry(book.bookId, {
      occurredAt: '2026-01-01T00:00:00.000Z',
      description: 'a sale',
      legs: [
        { accountId: book.cash, amount: '10.00', currency: 'EUR' },
        { accountId: book.sales, amount: '-10.00', currency: 'EUR' },
      ],
    });

    expect(result.created).toBe(true);
  });
});

describe('backdating', () => {
  it('rejects a backdated withdrawal that dips the history, even when today is positive', async () => {
    const book = await freshBook();

    // March: +10.00. April: +100.00. Today's balance is 110.00.
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-03-01T00:00:00.000Z'));
    await service.postEntry(book.bookId, deposit(book, book.cash, '100.00', '2026-04-01T00:00:00.000Z'));

    // A withdrawal of 50.00 dated between them. The final balance would be 60.00 - fine by
    // any current-balance rule - but on 15 March the account holds 10.00 and goes to -40.00.
    await expect(
      service.postEntry(book.bookId, withdrawal(book, book.cash, '50.00', '2026-03-15T00:00:00.000Z')),
    ).rejects.toThrow(AccountOverdrawnError);
  });

  it('accepts the same withdrawal once a backdated deposit covers it', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-03-01T00:00:00.000Z'));
    await service.postEntry(book.bookId, deposit(book, book.cash, '100.00', '2026-04-01T00:00:00.000Z'));

    await expect(
      service.postEntry(book.bookId, withdrawal(book, book.cash, '50.00', '2026-03-15T00:00:00.000Z')),
    ).rejects.toThrow(AccountOverdrawnError);

    // 2 March: the money was there all along, we just had not recorded it.
    await service.postEntry(book.bookId, deposit(book, book.cash, '60.00', '2026-03-02T00:00:00.000Z'));

    const result = await service.postEntry(
      book.bookId,
      withdrawal(book, book.cash, '50.00', '2026-03-15T00:00:00.000Z'),
    );

    expect(result.created).toBe(true);
  });
});

describe('within a single entry', () => {
  it('rejects an entry that dips between its own legs, even though it nets positive', async () => {
    const book = await freshBook();

    // -100.00 then +150.00 on cash: nets +50.00, and the prefix after the first leg is
    // -100.00. Per-leg, not per-net.
    await expect(
      service.postEntry(book.bookId, {
        occurredAt: '2026-01-01T00:00:00.000Z',
        description: 'net positive, momentarily negative',
        legs: [
          { accountId: book.cash, amount: '-100.00', currency: 'EUR' },
          { accountId: book.cash, amount: '150.00', currency: 'EUR' },
          { accountId: book.sales, amount: '-50.00', currency: 'EUR' },
        ],
      }),
    ).rejects.toThrow(AccountOverdrawnError);
  });
});

describe('reversals', () => {
  it('rejects a reversal that would overdraw the account', async () => {
    const book = await freshBook();

    const funded = await service.postEntry(
      book.bookId,
      deposit(book, book.cash, '100.00', '2026-01-01T00:00:00.000Z'),
    );
    await service.postEntry(book.bookId, withdrawal(book, book.cash, '80.00', '2026-02-01T00:00:00.000Z'));

    // Reversing the deposit takes 100.00 back out of an account holding 20.00.
    await expect(service.reverseEntry(book.bookId, funded.entry.id)).rejects.toThrow(
      AccountOverdrawnError,
    );
  });

  it('allows a reversal the balance can absorb', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '100.00', '2026-01-01T00:00:00.000Z'));
    const spent = await service.postEntry(
      book.bookId,
      withdrawal(book, book.cash, '30.00', '2026-02-01T00:00:00.000Z'),
    );

    const reversal = await service.reverseEntry(book.bookId, spent.entry.id);

    expect(reversal.reversalOf).toBe(spent.entry.id);
  });
});
