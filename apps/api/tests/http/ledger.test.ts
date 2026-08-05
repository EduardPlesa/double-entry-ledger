import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApplication, type TestApplication } from '../helpers/app.js';
import {
  bearer,
  createAccount,
  createBook,
  registerUser,
  type TestBook,
  type TestUser,
} from '../helpers/books.js';

/**
 * The ledger endpoints over HTTP.
 *
 * The service's own behaviour is covered against a real database in
 * `tests/services/ledger.service.test.ts`. What is under test here is the boundary: status
 * codes, `Location` headers, how amounts are serialised, and the fact that nothing crossing
 * this line is ever a JSON number.
 */

let application: TestApplication;
let owner: TestUser;
let book: TestBook;
let cash: string;
let sales: string;

beforeAll(async () => {
  application = createTestApplication();
  owner = await registerUser(application);
  book = await createBook(application, owner);
  cash = await createAccount(application, book, { name: 'Cash', type: 'asset' });
  sales = await createAccount(application, book, { name: 'Sales', type: 'revenue' });
});

afterAll(async () => {
  await application.close();
});

const api = () => request(application.app);
const auth = () => bearer(owner.accessToken);

function sale(overrides: Record<string, unknown> = {}) {
  return {
    occurredAt: '2026-03-01T12:00:00.000Z',
    description: 'a sale',
    legs: [
      { accountId: cash, amount: '10.00', currency: 'EUR' },
      { accountId: sales, amount: '-10.00', currency: 'EUR' },
    ],
    ...overrides,
  };
}

describe('POST /books/:bookId/accounts', () => {
  it('creates an account with a Location header', async () => {
    const response = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', auth())
      .send({ name: 'Rent', type: 'expense', currency: 'EUR' });

    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`/accounts/${response.body.id}`);
    expect(response.body).toMatchObject({ name: 'Rent', type: 'expense', currency: 'EUR' });
  });

  it('rejects a type that is not one of the five', async () => {
    const response = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', auth())
      .send({ name: 'Vibes', type: 'intangible', currency: 'EUR' });

    expect(response.status).toBe(400);
  });

  it('refuses a child whose currency differs from its parent', async () => {
    // Not a database constraint, and hard to make one: the tree would be representable and
    // its subtotals would not add up.
    const response = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', auth())
      .send({ name: 'Petty cash USD', type: 'asset', currency: 'USD', parentId: cash });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('CURRENCY_MISMATCH');
  });
});

describe('POST /books/:bookId/entries', () => {
  it('records a balanced entry, 201 with Location', async () => {
    const response = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send(sale());

    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`/entries/${response.body.id}`);
    expect(response.body.postings).toHaveLength(2);
  });

  it('serialises every amount as a decimal string, never a JSON number', async () => {
    // The rule the whole system is built around. A JSON number is an IEEE 754 double, and a
    // ledger that cannot round-trip its own values through its own API is not one to trust.
    const response = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send(sale());

    for (const posting of response.body.postings) {
      expect(typeof posting.amount).toBe('string');
      // Posting ids are bigserial and outrun Number.MAX_SAFE_INTEGER eventually.
      expect(typeof posting.id).toBe('string');
    }
    expect(response.body.postings.map((p: { amount: string }) => p.amount).sort()).toEqual([
      '-10.00',
      '10.00',
    ]);
  });

  it('holds an amount past Number.MAX_SAFE_INTEGER exactly, end to end', async () => {
    const huge = '90071992547409.93';

    const posted = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send(
        sale({
          legs: [
            { accountId: cash, amount: huge, currency: 'EUR' },
            { accountId: sales, amount: `-${huge}`, currency: 'EUR' },
          ],
        }),
      );

    expect(posted.status).toBe(201);

    const found = posted.body.postings.find((p: { amount: string }) => p.amount === huge);
    expect(found).toBeDefined();
  });

  it('answers 422 for an entry that does not balance', async () => {
    // Parses perfectly, describes something impossible. The 400/422 line exactly.
    const response = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send(
        sale({
          legs: [
            { accountId: cash, amount: '10.00', currency: 'EUR' },
            { accountId: sales, amount: '-9.99', currency: 'EUR' },
          ],
        }),
      );

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('ENTRY_UNBALANCED');
    expect(response.body.detail).toContain('EUR legs sum to 1');
  });

  it('answers 400 for a body that is not an entry', async () => {
    const response = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send({ description: 'no legs, no date' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('replays an entry with the same external id as 200, not 201', async () => {
    // Idempotency at the domain level: the same entry, and a status that says which happened.
    const externalId = `invoice-${Math.random().toString(36).slice(2)}`;

    const first = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send(sale({ externalId }));

    const second = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send(sale({ externalId }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('refuses a leg pointing into another book, without confirming it exists', async () => {
    const elsewhere = await createBook(application, await registerUser(application));
    const theirAccount = await createAccount(application, elsewhere);

    const response = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send(
        sale({
          legs: [
            { accountId: theirAccount, amount: '10.00', currency: 'EUR' },
            { accountId: sales, amount: '-10.00', currency: 'EUR' },
          ],
        }),
      );

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('GET /accounts/:accountId/balance', () => {
  it('derives the balance from the postings', async () => {
    const target = await createBook(application, owner);
    const targetCash = await createAccount(application, target, { name: 'Cash' });
    const targetSales = await createAccount(application, target, { name: 'Sales', type: 'revenue' });

    await api()
      .post(`/books/${target.bookId}/entries`)
      .set('Authorization', auth())
      .send({
        occurredAt: '2026-03-01T12:00:00.000Z',
        description: 'a sale',
        legs: [
          { accountId: targetCash, amount: '25.50', currency: 'EUR' },
          { accountId: targetSales, amount: '-25.50', currency: 'EUR' },
        ],
      });

    const response = await api()
      .get(`/accounts/${targetCash}/balance`)
      .set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ balance: '25.50', currency: 'EUR', asOf: null });
  });

  it('answers as of a point in occurred time', async () => {
    const target = await createBook(application, owner);
    const targetCash = await createAccount(application, target, { name: 'Cash' });
    const targetSales = await createAccount(application, target, { name: 'Sales', type: 'revenue' });

    const post = (occurredAt: string, amount: string) =>
      api()
        .post(`/books/${target.bookId}/entries`)
        .set('Authorization', auth())
        .send({
          occurredAt,
          description: 'a sale',
          legs: [
            { accountId: targetCash, amount, currency: 'EUR' },
            { accountId: targetSales, amount: `-${amount}`, currency: 'EUR' },
          ],
        });

    await post('2026-01-15T00:00:00.000Z', '10.00');
    await post('2026-02-15T00:00:00.000Z', '20.00');

    const january = await api()
      .get(`/accounts/${targetCash}/balance`)
      .query({ asOf: '2026-02-01T00:00:00.000Z' })
      .set('Authorization', auth());

    expect(january.body.balance).toBe('10.00');
    expect(january.body.asOf).toBe('2026-02-01T00:00:00.000Z');
  });

  it('rejects an asOf that is not an instant', async () => {
    const response = await api()
      .get(`/accounts/${cash}/balance`)
      .query({ asOf: 'tuesday' })
      .set('Authorization', auth());

    expect(response.status).toBe(400);
  });
});

describe('GET /books/:bookId/accounts', () => {
  it('lists the book\'s accounts with their parent and closed state', async () => {
    const response = await api()
      .get(`/books/${book.bookId}/accounts`)
      .set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: cash,
          name: 'Cash',
          type: 'asset',
          currency: 'EUR',
          parentId: null,
          closedAt: null,
        }),
      ]),
    );
  });

  it('reports a child account\'s parent', async () => {
    const child = await createAccount(application, book, {
      name: 'Petty cash',
      type: 'asset',
      parentId: cash,
    });

    const response = await api()
      .get(`/books/${book.bookId}/accounts`)
      .set('Authorization', auth());

    const found = response.body.find((account: { id: string }) => account.id === child);
    expect(found.parentId).toBe(cash);
  });

  it('refuses a caller with no membership in the book', async () => {
    // 404, not 403: the same anti-enumeration answer every other `bookFrom: 'param'` route
    // gives a non-member, so that membership cannot be probed with an id and a stopwatch. See
    // `tests/http/authorization.test.ts`, "a caller who is not a member".
    const stranger = await registerUser(application);
    const response = await api()
      .get(`/books/${book.bookId}/accounts`)
      .set('Authorization', bearer(stranger.accessToken));

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('BOOK_NOT_FOUND');
  });
});

describe('GET /accounts/:accountId/postings', () => {
  let pagedAccount: string;

  beforeAll(async () => {
    const target = await createBook(application, owner);
    pagedAccount = await createAccount(application, target, { name: 'Cash' });
    const counter = await createAccount(application, target, { name: 'Sales', type: 'revenue' });

    for (let index = 0; index < 5; index += 1) {
      await api()
        .post(`/books/${target.bookId}/entries`)
        .set('Authorization', auth())
        .send({
          occurredAt: '2026-03-01T12:00:00.000Z',
          description: `entry ${String(index)}`,
          legs: [
            { accountId: pagedAccount, amount: '1.00', currency: 'EUR' },
            { accountId: counter, amount: '-1.00', currency: 'EUR' },
          ],
        });
    }
  });

  it('pages with a cursor and carries a running balance across pages', async () => {
    const first = await api()
      .get(`/accounts/${pagedAccount}/postings`)
      .query({ limit: 2 })
      .set('Authorization', auth());

    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items.map((i: { runningBalance: string }) => i.runningBalance)).toEqual([
      '1.00',
      '2.00',
    ]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await api()
      .get(`/accounts/${pagedAccount}/postings`)
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set('Authorization', auth());

    // The running balance continues from where the previous page left off rather than
    // restarting, which is the whole reason the opening balance is computed from the cursor.
    expect(second.body.items.map((i: { runningBalance: string }) => i.runningBalance)).toEqual([
      '3.00',
      '4.00',
    ]);
  });

  it('reports no cursor on the last page', async () => {
    const response = await api()
      .get(`/accounts/${pagedAccount}/postings`)
      .query({ limit: 50 })
      .set('Authorization', auth());

    expect(response.body.items).toHaveLength(5);
    expect(response.body.nextCursor).toBeNull();
  });

  it('rejects a cursor it did not issue', async () => {
    const response = await api()
      .get(`/accounts/${pagedAccount}/postings`)
      .query({ cursor: 'obviously-not-a-cursor' })
      .set('Authorization', auth());

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_CURSOR');
  });

  it('rejects a limit outside the range it will serve', async () => {
    const tooMany = await api()
      .get(`/accounts/${pagedAccount}/postings`)
      .query({ limit: 5000 })
      .set('Authorization', auth());

    expect(tooMany.status).toBe(400);
  });
});
