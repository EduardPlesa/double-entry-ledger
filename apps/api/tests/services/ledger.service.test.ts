import { formatMoney, newId } from '@ledger/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  AccountClosedError,
  AccountNotFoundError,
  BookNotFoundError,
  CurrencyMismatchError,
  InvalidCursorError,
  UnbalancedEntryError,
  ValidationError,
} from '../../src/domain/errors.js';
import type { LedgerService, PostEntryInput } from '../../src/services/ledger.service.js';
import { seedBookIn, withBookClient, type Book } from '../helpers/ledger.js';
import {
  START,
  createService,
  createServiceWithFailingTransaction,
  createServiceWithoutDatabase,
  type ServiceHarness,
} from '../helpers/service.js';

/**
 * The service against a real Postgres. Same container as the invariant tests, same
 * migrations, same two roles - this connects as ledger_app, which is the connection the
 * application will actually hold, so anything these tests do is something the running
 * system is permitted to do.
 */

let pool: Pool;
let harness: ServiceHarness;
let service: LedgerService;
let book: Book;

const OCCURRED = '2026-03-01T12:00:00.000Z';

beforeAll(async () => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 6 });
  harness = createService(pool);
  service = harness.service;
  book = await seedBookIn(pool);
});

afterAll(async () => {
  await pool.end();
});

/** €10.00 from sales into cash, the smallest entry that means anything. */
function sale(overrides: Partial<PostEntryInput> = {}, target: Book = book): PostEntryInput {
  return {
    occurredAt: OCCURRED,
    description: 'a sale',
    legs: [
      { accountId: target.cash, amount: '10.00', currency: 'EUR' },
      { accountId: target.sales, amount: '-10.00', currency: 'EUR' },
    ],
    ...overrides,
  };
}

async function freshBook(): Promise<Book> {
  return seedBookIn(pool);
}

async function countEntries(bookId: string): Promise<number> {
  // Through a book context, like every other read of this table since migration 0006. A bare
  // pool query would see nothing and this helper would cheerfully report zero entries.
  const result = await withBookClient(pool, bookId, (client) =>
    client.query<{ n: number }>('SELECT count(*)::int AS n FROM entries WHERE book_id = $1', [bookId]),
  );
  return result.rows[0]?.n ?? 0;
}

describe('postEntry', () => {
  it('records a balanced entry and its legs in one transaction', async () => {
    const target = await freshBook();
    const { entry, created } = await service.postEntry(target.bookId, sale({}, target));

    expect(created).toBe(true);
    expect(entry.bookId).toBe(target.bookId);
    expect(entry.description).toBe('a sale');
    expect(entry.occurredAt.toISOString()).toBe(OCCURRED);
    expect(entry.postings).toHaveLength(2);

    // Amounts are bigints on the way out, exactly as they went in.
    expect(entry.postings.map((p) => p.amountMinor).sort()).toEqual([-1000n, 1000n]);

    const cash = await service.getBalance(target.bookId, target.cash);
    const sales = await service.getBalance(target.bookId, target.sales);
    expect(cash.balance.amountMinor).toBe(1000n);
    expect(sales.balance.amountMinor).toBe(-1000n);
    expect(cash.balance.currency).toBe('EUR');
  });

  it('takes recorded_at from the injected clock, never from the wall clock', async () => {
    const target = await freshBook();
    harness.clock.set(new Date('2026-04-01T10:30:00.000Z'));

    const { entry } = await service.postEntry(target.bookId, sale({}, target));
    expect(entry.recordedAt.toISOString()).toBe('2026-04-01T10:30:00.000Z');

    // occurred_at is the caller's assertion about the world and is untouched by the clock.
    expect(entry.occurredAt.toISOString()).toBe(OCCURRED);

    harness.clock.set(START);
  });

  it('accepts a balanced multi-leg entry', async () => {
    const target = await freshBook();

    // Funds both asset accounts before the split withdrawal below. Without this, cash and
    // bank start at zero and the entry would overdraw them under the rule task 3 adds - a
    // real violation, not an artifact of the fixture, and unrelated to what this test is
    // actually about.
    await service.postEntry(target.bookId, {
      occurredAt: '2026-02-01T00:00:00.000Z',
      description: 'funding for the split rent payment',
      legs: [
        { accountId: target.cash, amount: '70.00', currency: 'EUR' },
        { accountId: target.bank, amount: '30.00', currency: 'EUR' },
        { accountId: target.sales, amount: '-100.00', currency: 'EUR' },
      ],
    });

    const { entry } = await service.postEntry(target.bookId, {
      occurredAt: OCCURRED,
      description: 'rent, split',
      legs: [
        { accountId: target.cash, amount: '-70.00', currency: 'EUR' },
        { accountId: target.bank, amount: '-30.00', currency: 'EUR' },
        { accountId: target.rent, amount: '100.00', currency: 'EUR' },
      ],
    });

    expect(entry.postings).toHaveLength(3);
    expect((await service.getBalance(target.bookId, target.rent)).balance.amountMinor).toBe(10_000n);
  });

  it('accepts an entry that balances independently in each currency it touches', async () => {
    const target = await freshBook();
    const { entry } = await service.postEntry(target.bookId, {
      occurredAt: OCCURRED,
      description: 'two currencies, two balanced pairs',
      legs: [
        { accountId: target.cash, amount: '10.00', currency: 'EUR' },
        { accountId: target.sales, amount: '-10.00', currency: 'EUR' },
        { accountId: target.cashUsd, amount: '20.00', currency: 'USD' },
        { accountId: target.salesUsd, amount: '-20.00', currency: 'USD' },
      ],
    });

    expect(entry.postings).toHaveLength(4);
  });

  it('holds amounts beyond Number.MAX_SAFE_INTEGER exactly, end to end', async () => {
    const target = await freshBook();
    // 9_007_199_254_740_993 minor units: one cent past the last integer a double can hold.
    await service.postEntry(target.bookId, {
      occurredAt: OCCURRED,
      description: 'a large sum',
      legs: [
        { accountId: target.cash, amount: '90071992547409.93', currency: 'EUR' },
        { accountId: target.sales, amount: '-90071992547409.93', currency: 'EUR' },
      ],
    });

    const balance = await service.getBalance(target.bookId, target.cash);
    expect(balance.balance.amountMinor).toBe(9_007_199_254_740_993n);
    expect(formatMoney(balance.balance)).toBe('90071992547409.93');
  });
});

describe('postEntry, rejections', () => {
  it('rejects an unbalanced entry before opening a transaction', async () => {
    // Wired to a unit of work that throws if touched: the assertion is not only that this
    // fails, but that it fails without a round trip.
    const offline = createServiceWithoutDatabase();

    await expect(
      offline.postEntry(book.bookId, {
        occurredAt: OCCURRED,
        description: 'off by a cent',
        legs: [
          { accountId: book.cash, amount: '10.00', currency: 'EUR' },
          { accountId: book.sales, amount: '-9.99', currency: 'EUR' },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'ENTRY_UNBALANCED',
      imbalances: [{ currency: 'EUR', amountMinor: 1n }],
    });
  });

  it('rejects an entry that nets to zero across currencies but balances in neither', async () => {
    const offline = createServiceWithoutDatabase();

    const error = await offline
      .postEntry(book.bookId, {
        occurredAt: OCCURRED,
        description: 'EUR against USD',
        legs: [
          { accountId: book.cash, amount: '10.00', currency: 'EUR' },
          { accountId: book.salesUsd, amount: '-10.00', currency: 'USD' },
        ],
      })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(UnbalancedEntryError);
    expect((error as UnbalancedEntryError).imbalances).toEqual([
      { currency: 'EUR', amountMinor: 1000n },
      { currency: 'USD', amountMinor: -1000n },
    ]);
  });

  it('rejects amounts and shapes that cannot mean anything', async () => {
    const offline = createServiceWithoutDatabase();
    const base = { occurredAt: OCCURRED, description: 'nope' };

    const cases: PostEntryInput[] = [
      // Three decimal places in a two-decimal currency: rounding is the caller's decision.
      {
        ...base,
        legs: [
          { accountId: book.cash, amount: '10.005', currency: 'EUR' },
          { accountId: book.sales, amount: '-10.005', currency: 'EUR' },
        ],
      },
      // A zero leg carries no accounting meaning.
      {
        ...base,
        legs: [
          { accountId: book.cash, amount: '0.00', currency: 'EUR' },
          { accountId: book.sales, amount: '0.00', currency: 'EUR' },
        ],
      },
      // One leg can never balance.
      { ...base, legs: [{ accountId: book.cash, amount: '10.00', currency: 'EUR' }] },
      // Blank description.
      { ...base, description: '   ', legs: sale().legs },
      // A float, which is exactly what the string boundary exists to keep out.
      {
        ...base,
        legs: [
          { accountId: book.cash, amount: 10 as unknown as string, currency: 'EUR' },
          { accountId: book.sales, amount: '-10.00', currency: 'EUR' },
        ],
      },
    ];

    for (const input of cases) {
      await expect(offline.postEntry(book.bookId, input)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('rejects a leg pointing at an account that does not exist, and writes nothing', async () => {
    const target = await freshBook();
    const before = await countEntries(target.bookId);

    await expect(
      service.postEntry(target.bookId, {
        occurredAt: OCCURRED,
        description: 'ghost account',
        legs: [
          { accountId: newId(), amount: '10.00', currency: 'EUR' },
          { accountId: target.sales, amount: '-10.00', currency: 'EUR' },
        ],
      }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);

    expect(await countEntries(target.bookId)).toBe(before);
  });

  it('rejects a book that does not exist', async () => {
    await expect(
      service.postEntry(newId(), {
        occurredAt: OCCURRED,
        description: 'ghost book',
        legs: [
          { accountId: newId(), amount: '10.00', currency: 'EUR' },
          { accountId: newId(), amount: '-10.00', currency: 'EUR' },
        ],
      }),
    ).rejects.toBeInstanceOf(BookNotFoundError);
  });

  it('rejects a leg pointing at another book’s account, without confirming it exists', async () => {
    // Not `AccountNotInBookError`. Since migration 0006 the other book's account is not
    // visible from inside this book's context at all, so the service cannot tell "somebody
    // else's account" from "no such account" - and should not be able to. Answering the more
    // precise error would confirm the existence of a row the caller is not authorised to
    // know about, which is a membership oracle for anyone holding an id.
    //
    // The `bookId` comparison in `assertPostable` stays anyway. It is one map lookup, and it
    // is the check that still holds if row-level security is ever disabled on a replica.
    const target = await freshBook();
    const other = await freshBook();

    await expect(
      service.postEntry(target.bookId, {
        occurredAt: OCCURRED,
        description: 'cross-book leg',
        legs: [
          { accountId: other.cash, amount: '10.00', currency: 'EUR' },
          { accountId: target.sales, amount: '-10.00', currency: 'EUR' },
        ],
      }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it('rejects a leg denominated in a currency its account does not hold', async () => {
    const target = await freshBook();

    await expect(
      service.postEntry(target.bookId, {
        occurredAt: OCCURRED,
        description: 'EUR account, USD leg',
        legs: [
          { accountId: target.cash, amount: '10.00', currency: 'USD' },
          { accountId: target.salesUsd, amount: '-10.00', currency: 'USD' },
        ],
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });

  it('translates the database’s own zero-sum verdict, if the application check ever misses one', async () => {
    // LG001 is raised by the deferred trigger at COMMIT. Reaching it means the check in
    // application code has a hole; the entry is still rejected, and the caller still gets a
    // domain error rather than a SQLSTATE.
    const failing = createServiceWithFailingTransaction(
      Object.assign(new Error('entry is unbalanced'), { code: 'LG001' }),
    );

    await expect(failing.postEntry(book.bookId, sale())).rejects.toBeInstanceOf(UnbalancedEntryError);
  });

  it('lets an error it does not recognise propagate untouched', async () => {
    const failure = Object.assign(new Error('connection terminated'), { code: '08006' });
    const failing = createServiceWithFailingTransaction(failure);

    await expect(failing.postEntry(book.bookId, sale())).rejects.toBe(failure);
  });

  it('rejects a posting to a closed account', async () => {
    const target = await freshBook();

    // In a book context, because row-level security is not a filter that complains: without
    // one this UPDATE matches zero rows, reports success, and the test goes on to assert
    // about an account that was never closed.
    await withBookClient(pool, target.bookId, (client) =>
      client.query('UPDATE accounts SET closed_at = now() WHERE id = $1', [target.bank]),
    );

    await expect(
      service.postEntry(target.bookId, {
        occurredAt: OCCURRED,
        description: 'to a closed account',
        legs: [
          { accountId: target.bank, amount: '10.00', currency: 'EUR' },
          { accountId: target.sales, amount: '-10.00', currency: 'EUR' },
        ],
      }),
    ).rejects.toBeInstanceOf(AccountClosedError);
  });
});

describe('postEntry, idempotency', () => {
  it('returns the existing entry instead of recording a second one', async () => {
    const target = await freshBook();
    const externalId = `invoice-${newId()}`;

    const first = await service.postEntry(target.bookId, sale({ externalId }, target));
    const second = await service.postEntry(target.bookId, sale({ externalId }, target));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.postings).toHaveLength(2);

    expect(await countEntries(target.bookId)).toBe(1);
    expect((await service.getBalance(target.bookId, target.cash)).balance.amountMinor).toBe(1000n);
  });

  it('is keyed on external_id alone: a replay with different legs returns what was recorded', async () => {
    // The caller said "this is the same operation". Honouring that is the point; the
    // alternative - a 409 on a retry whose first attempt actually succeeded - is the failure
    // mode idempotency exists to prevent. Detecting a *changed* payload under a reused key
    // is a distinct concern, and belongs with stage 3's Idempotency-Key header.
    const target = await freshBook();
    const externalId = `invoice-${newId()}`;

    const first = await service.postEntry(target.bookId, sale({ externalId }, target));
    const replay = await service.postEntry(
      target.bookId,
      sale(
        {
          externalId,
          legs: [
            { accountId: target.cash, amount: '999.00', currency: 'EUR' },
            { accountId: target.sales, amount: '-999.00', currency: 'EUR' },
          ],
        },
        target,
      ),
    );

    expect(replay.created).toBe(false);
    expect(replay.entry.id).toBe(first.entry.id);
    expect((await service.getBalance(target.bookId, target.cash)).balance.amountMinor).toBe(1000n);
  });

  it('records exactly one entry when two callers race with the same external_id', async () => {
    // Both requests read "no such entry", both try to insert, one loses on the unique index
    // and has to recover by reading the winner's row. The recovery is the code path under
    // test; without it the loser sees a raw 23505.
    const target = await freshBook();
    const externalId = `invoice-${newId()}`;

    const results = await Promise.all([
      service.postEntry(target.bookId, sale({ externalId }, target)),
      service.postEntry(target.bookId, sale({ externalId }, target)),
      service.postEntry(target.bookId, sale({ externalId }, target)),
    ]);

    const ids = new Set(results.map((result) => result.entry.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await countEntries(target.bookId)).toBe(1);
  });

  it('scopes external_id to the book, so two books may use the same one', async () => {
    const first = await freshBook();
    const second = await freshBook();
    const externalId = `invoice-${newId()}`;

    const a = await service.postEntry(first.bookId, sale({ externalId }, first));
    const b = await service.postEntry(second.bookId, sale({ externalId }, second));

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.entry.id).not.toBe(b.entry.id);
  });
});

describe('getBalance', () => {
  it('sums the account’s postings', async () => {
    const target = await freshBook();
    await service.postEntry(target.bookId, sale({}, target));
    await service.postEntry(target.bookId, sale({ description: 'another sale' }, target));

    const balance = await service.getBalance(target.bookId, target.cash);
    expect(balance.balance.amountMinor).toBe(2000n);
    expect(balance.asOf).toBeNull();
  });

  it('is zero for an account with no postings', async () => {
    const target = await freshBook();
    const balance = await service.getBalance(target.bookId, target.cash);

    expect(balance.balance.amountMinor).toBe(0n);
    expect(balance.balance.currency).toBe('EUR');
  });

  it('answers as of a point in occurred time, including the boundary', async () => {
    const target = await freshBook();

    await service.postEntry(target.bookId, sale({ occurredAt: '2026-01-15T00:00:00.000Z' }, target));
    await service.postEntry(target.bookId, sale({ occurredAt: '2026-06-15T00:00:00.000Z' }, target));

    const march = await service.getBalance(target.bookId, target.cash, new Date('2026-03-01T00:00:00.000Z'));
    expect(march.balance.amountMinor).toBe(1000n);
    expect(march.asOf?.toISOString()).toBe('2026-03-01T00:00:00.000Z');

    const onTheDay = await service.getBalance(target.bookId, target.cash, new Date('2026-01-15T00:00:00.000Z'));
    expect(onTheDay.balance.amountMinor).toBe(1000n);

    expect((await service.getBalance(target.bookId, target.cash)).balance.amountMinor).toBe(2000n);
  });

  it('counts a backdated entry against the period it happened in, not the one it was recorded in', async () => {
    // Recorded now, occurred in January. This is precisely what invalidates a date-keyed
    // balance cache, and why stage 7's checkpoints are keyed on posting id.
    const target = await freshBook();
    await service.postEntry(target.bookId, sale({ occurredAt: '2026-06-15T00:00:00.000Z' }, target));
    await service.postEntry(target.bookId, sale({ occurredAt: '2026-01-02T00:00:00.000Z' }, target));

    const january = await service.getBalance(target.bookId, target.cash, new Date('2026-02-01T00:00:00.000Z'));
    expect(january.balance.amountMinor).toBe(1000n);
  });

  it('rejects an account that does not exist', async () => {
    await expect(service.getBalance(book.bookId, newId())).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});

describe('listPostings', () => {
  /** Five sales of €1, €2 ... €5, all on the same account, in a known order. */
  async function bookWithFivePostings(): Promise<Book> {
    const target = await freshBook();
    for (const amount of ['1.00', '2.00', '3.00', '4.00', '5.00']) {
      await service.postEntry(target.bookId, {
        occurredAt: OCCURRED,
        description: `sale of ${amount}`,
        legs: [
          { accountId: target.cash, amount, currency: 'EUR' },
          { accountId: target.sales, amount: `-${amount}`, currency: 'EUR' },
        ],
      });
    }
    return target;
  }

  it('pages oldest first, carrying the running balance across pages', async () => {
    const target = await bookWithFivePostings();

    const first = await service.listPostings(target.bookId, target.cash, { limit: 2 });
    expect(first.items.map((item) => item.amount.amountMinor)).toEqual([100n, 200n]);
    expect(first.items.map((item) => item.runningBalance.amountMinor)).toEqual([100n, 300n]);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.listPostings(target.bookId, target.cash, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    // The second page continues the total rather than restarting it - the property that
    // makes a running balance worth anything.
    expect(second.items.map((item) => item.runningBalance.amountMinor)).toEqual([600n, 1000n]);

    const third = await service.listPostings(target.bookId, target.cash, {
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });
    expect(third.items).toHaveLength(1);
    expect(third.items[0]?.runningBalance.amountMinor).toBe(1500n);

    // The last page says so, and the last running balance is the balance.
    expect(third.nextCursor).toBeNull();
    expect((await service.getBalance(target.bookId, target.cash)).balance.amountMinor).toBe(1500n);
  });

  it('reports no next cursor when the last page is exactly full', async () => {
    const target = await bookWithFivePostings();
    const page = await service.listPostings(target.bookId, target.cash, { limit: 5 });

    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it('carries the entry’s description and timestamps onto each line', async () => {
    const target = await bookWithFivePostings();
    const page = await service.listPostings(target.bookId, target.cash, { limit: 1 });
    const line = page.items[0];

    expect(line?.description).toBe('sale of 1.00');
    expect(line?.occurredAt.toISOString()).toBe(OCCURRED);
    expect(line?.recordedAt.toISOString()).toBe(START.toISOString());
    expect(line?.amount.currency).toBe('EUR');
  });

  it('is empty, with no cursor, for an account with no postings', async () => {
    const target = await freshBook();
    const page = await service.listPostings(target.bookId, target.cash);

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a cursor it did not issue', async () => {
    const target = await freshBook();

    for (const cursor of ['nonsense', Buffer.from('p2:1').toString('base64url'), 'AAAA']) {
      await expect(service.listPostings(target.bookId, target.cash, { cursor })).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    }
  });

  it('rejects a page size outside the permitted range', async () => {
    const target = await freshBook();

    await expect(service.listPostings(target.bookId, target.cash, { limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.listPostings(target.bookId, target.cash, { limit: 5000 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects an account that does not exist', async () => {
    await expect(service.listPostings(book.bookId, newId())).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});
