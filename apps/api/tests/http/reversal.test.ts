import { newId } from '@ledger/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApplication, type TestApplication } from '../helpers/app.js';
import {
  addMember,
  bearer,
  createAccount,
  createBook,
  registerUser,
  type TestBook,
  type TestUser,
} from '../helpers/books.js';
import { queryInBook } from '../helpers/ledger.js';

/**
 * Reversals and the trial balance.
 *
 * The property these two share, and the reason they are tested together: a reversal must
 * leave the book exactly as balanced as it found it. The trial balance is the report that
 * says so, and every assertion here about a corrected mistake ends with it.
 */

let application: TestApplication;
let owner: TestUser;

beforeAll(async () => {
  application = createTestApplication();
  owner = await registerUser(application);
});

afterAll(async () => {
  await application.close();
});

const api = () => request(application.app);
const auth = () => bearer(owner.accessToken);

interface Fixture {
  book: TestBook;
  cash: string;
  sales: string;
}

async function freshBook(): Promise<Fixture> {
  const book = await createBook(application, owner);
  return {
    book,
    cash: await createAccount(application, book, { name: 'Cash', type: 'asset' }),
    sales: await createAccount(application, book, { name: 'Sales', type: 'revenue' }),
  };
}

async function post(fixture: Fixture, amount: string, description = 'a sale') {
  return api()
    .post(`/books/${fixture.book.bookId}/entries`)
    .set('Authorization', auth())
    .send({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description,
      legs: [
        { accountId: fixture.cash, amount, currency: 'EUR' },
        { accountId: fixture.sales, amount: `-${amount}`, currency: 'EUR' },
      ],
    });
}

const balanceOf = async (accountId: string) =>
  (await api().get(`/accounts/${accountId}/balance`).set('Authorization', auth())).body.balance;

describe('POST /entries/:entryId/reverse', () => {
  it('records a new entry with every leg negated', async () => {
    const fixture = await freshBook();
    const original = await post(fixture, '10.00');

    const response = await api()
      .post(`/entries/${original.body.id}/reverse`)
      .set('Authorization', auth())
      .send({});

    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`/entries/${response.body.id}`);
    expect(response.body.reversalOf).toBe(original.body.id);

    const amounts = response.body.postings.map((p: { amount: string }) => p.amount).sort();
    expect(amounts).toEqual(['-10.00', '10.00']);
  });

  it('restores every affected balance exactly', async () => {
    const fixture = await freshBook();
    const original = await post(fixture, '42.55');

    expect(await balanceOf(fixture.cash)).toBe('42.55');

    await api().post(`/entries/${original.body.id}/reverse`).set('Authorization', auth()).send({});

    expect(await balanceOf(fixture.cash)).toBe('0.00');
    expect(await balanceOf(fixture.sales)).toBe('0.00');
  });

  it('leaves the original entry untouched', async () => {
    // The whole point. Correction is addition, never rewriting - the database will not permit
    // an UPDATE against history from any role, so this is a property of the system rather than
    // of the service.
    const fixture = await freshBook();
    const original = await post(fixture, '10.00');

    await api().post(`/entries/${original.body.id}/reverse`).set('Authorization', auth()).send({});

    const postings = await api()
      .get(`/accounts/${fixture.cash}/postings`)
      .set('Authorization', auth());

    // Two postings on the account, not one amended one.
    expect(postings.body.items).toHaveLength(2);
    expect(postings.body.items[0].amount).toBe('10.00');
    expect(postings.body.items[1].amount).toBe('-10.00');
    expect(postings.body.items[1].runningBalance).toBe('0.00');
  });

  it('refuses to reverse the same entry twice', async () => {
    const fixture = await freshBook();
    const original = await post(fixture, '10.00');

    const first = await api()
      .post(`/entries/${original.body.id}/reverse`)
      .set('Authorization', auth())
      .send({});

    const second = await api()
      .post(`/entries/${original.body.id}/reverse`)
      .set('Authorization', auth())
      .send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ENTRY_ALREADY_REVERSED');
    expect(second.body.detail).toContain(first.body.id);
  });

  it('permits reversing a reversal', async () => {
    // A reversal is an ordinary entry, so correcting one is an ordinary correction. Reversing
    // the reversal puts the original effect back, which is what a mistaken correction needs.
    const fixture = await freshBook();
    const original = await post(fixture, '10.00');

    const reversal = await api()
      .post(`/entries/${original.body.id}/reverse`)
      .set('Authorization', auth())
      .send({});

    const undone = await api()
      .post(`/entries/${reversal.body.id}/reverse`)
      .set('Authorization', auth())
      .send({});

    expect(undone.status).toBe(201);
    expect(await balanceOf(fixture.cash)).toBe('10.00');
  });

  it('describes itself, unless told otherwise', async () => {
    const fixture = await freshBook();
    const original = await post(fixture, '10.00', 'Invoice 1041');

    const automatic = await api()
      .post(`/entries/${original.body.id}/reverse`)
      .set('Authorization', auth())
      .send({});

    expect(automatic.body.description).toBe('Reversal of: Invoice 1041');

    const second = await post(fixture, '10.00', 'Invoice 1042');
    const explicit = await api()
      .post(`/entries/${second.body.id}/reverse`)
      .set('Authorization', auth())
      .send({ description: 'Customer cancelled' });

    expect(explicit.body.description).toBe('Customer cancelled');
  });

  it('is 404 for an entry in another book, and for one that does not exist', async () => {
    const mine = await freshBook();
    const theirs = await freshBook();
    const theirEntry = await post(theirs, '10.00');

    const stranger = await registerUser(application);

    const notMine = await api()
      .post(`/entries/${theirEntry.body.id}/reverse`)
      .set('Authorization', bearer(stranger.accessToken))
      .send({});

    const imaginary = await api()
      .post(`/entries/${newId()}/reverse`)
      .set('Authorization', auth())
      .send({});

    expect(notMine.status).toBe(404);
    expect(imaginary.status).toBe(404);
    expect(mine.book.bookId).not.toBe(theirs.book.bookId);
  });

  it('needs entry:reverse, which a viewer does not have', async () => {
    const fixture = await freshBook();
    const original = await post(fixture, '10.00');
    const viewer = await addMember(application, fixture.book, 'viewer');

    const response = await api()
      .post(`/entries/${original.body.id}/reverse`)
      .set('Authorization', bearer(viewer.accessToken))
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.detail).toContain('entry:reverse');
  });

  it('records who reversed it', async () => {
    const fixture = await freshBook();
    const original = await post(fixture, '10.00');

    const reversal = await api()
      .post(`/entries/${original.body.id}/reverse`)
      .set('Authorization', auth())
      .send({});

    // Through a book context. `entries` is behind a policy, and a bare pool query would come
    // back empty rather than failing, which is how this assertion would pass for the wrong
    // reason if it were written the obvious way.
    const rows = await queryInBook<{ created_by_user_id: string | null }>(
      application.pool,
      fixture.book.bookId,
      'SELECT created_by_user_id FROM entries WHERE id = $1',
      [reversal.body.id],
    );

    expect(rows[0]?.created_by_user_id).toBe(owner.userId);
  });
});

describe('GET /books/:bookId/trial-balance', () => {
  it('lists every account, including the ones with no postings', async () => {
    // A report that quietly dropped the accounts it found least interesting would be a strange
    // sort of trial balance.
    const fixture = await freshBook();
    await createAccount(application, fixture.book, { name: 'Rent', type: 'expense' });
    await post(fixture, '10.00');

    const response = await api()
      .get(`/books/${fixture.book.bookId}/trial-balance`)
      .set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(response.body.accounts).toHaveLength(3);

    const rent = response.body.accounts.find((a: { name: string }) => a.name === 'Rent');
    expect(rent.balance).toBe('0.00');
  });

  it('asserts that debits equal credits', async () => {
    const fixture = await freshBook();
    await post(fixture, '10.00');
    await post(fixture, '25.50');

    const response = await api()
      .get(`/books/${fixture.book.bookId}/trial-balance`)
      .set('Authorization', auth());

    expect(response.body.balanced).toBe(true);
    expect(response.body.totals).toEqual([
      { currency: 'EUR', debits: '35.50', credits: '35.50', balanced: true },
    ]);
  });

  it('still balances after a reversal', async () => {
    const fixture = await freshBook();
    const original = await post(fixture, '10.00');

    await api().post(`/entries/${original.body.id}/reverse`).set('Authorization', auth()).send({});

    const response = await api()
      .get(`/books/${fixture.book.bookId}/trial-balance`)
      .set('Authorization', auth());

    expect(response.body.balanced).toBe(true);
    expect(response.body.totals).toEqual([
      { currency: 'EUR', debits: '0.00', credits: '0.00', balanced: true },
    ]);
  });

  it('totals each currency on its own', async () => {
    // Adding a EUR balance to a USD one produces a number that means nothing. Each currency
    // balances independently or the book is broken - the same rule the zero-sum invariant
    // applies to a single entry.
    const fixture = await freshBook();
    const cashUsd = await createAccount(application, fixture.book, {
      name: 'Cash USD',
      type: 'asset',
      currency: 'USD',
    });
    const salesUsd = await createAccount(application, fixture.book, {
      name: 'Sales USD',
      type: 'revenue',
      currency: 'USD',
    });

    await post(fixture, '10.00');
    await api()
      .post(`/books/${fixture.book.bookId}/entries`)
      .set('Authorization', auth())
      .send({
        occurredAt: '2026-03-01T12:00:00.000Z',
        description: 'a dollar sale',
        legs: [
          { accountId: cashUsd, amount: '20.00', currency: 'USD' },
          { accountId: salesUsd, amount: '-20.00', currency: 'USD' },
        ],
      });

    const response = await api()
      .get(`/books/${fixture.book.bookId}/trial-balance`)
      .set('Authorization', auth());

    expect(response.body.totals).toEqual([
      { currency: 'EUR', debits: '10.00', credits: '10.00', balanced: true },
      { currency: 'USD', debits: '20.00', credits: '20.00', balanced: true },
    ]);
  });

  it('answers as of a point in occurred time, without dropping empty accounts', async () => {
    // The filter is on the aggregate, not the join and not the where. In the where it would
    // discard the outer join's null rows and silently turn the report into an inner join.
    const fixture = await freshBook();

    const at = (occurredAt: string, amount: string) =>
      api()
        .post(`/books/${fixture.book.bookId}/entries`)
        .set('Authorization', auth())
        .send({
          occurredAt,
          description: 'a sale',
          legs: [
            { accountId: fixture.cash, amount, currency: 'EUR' },
            { accountId: fixture.sales, amount: `-${amount}`, currency: 'EUR' },
          ],
        });

    await at('2026-01-15T00:00:00.000Z', '10.00');
    await at('2026-02-15T00:00:00.000Z', '20.00');

    const january = await api()
      .get(`/books/${fixture.book.bookId}/trial-balance`)
      .query({ asOf: '2026-02-01T00:00:00.000Z' })
      .set('Authorization', auth());

    expect(january.body.accounts).toHaveLength(2);
    expect(january.body.totals).toEqual([
      { currency: 'EUR', debits: '10.00', credits: '10.00', balanced: true },
    ]);
    expect(january.body.balanced).toBe(true);
  });

  it('is readable by a viewer', async () => {
    const fixture = await freshBook();
    const viewer = await addMember(application, fixture.book, 'viewer');

    const response = await api()
      .get(`/books/${fixture.book.bookId}/trial-balance`)
      .set('Authorization', bearer(viewer.accessToken));

    expect(response.status).toBe(200);
  });

  it('is 404 for a book the caller is not in', async () => {
    const fixture = await freshBook();
    const stranger = await registerUser(application);

    const response = await api()
      .get(`/books/${fixture.book.bookId}/trial-balance`)
      .set('Authorization', bearer(stranger.accessToken));

    expect(response.status).toBe(404);
  });

  it('sees only its own book', async () => {
    // Row-level security, from the outside. Two books with data in each, and the report for
    // one contains nothing from the other.
    const mine = await freshBook();
    const theirs = await freshBook();

    await post(mine, '10.00');
    await post(theirs, '99.00');

    const response = await api()
      .get(`/books/${mine.book.bookId}/trial-balance`)
      .set('Authorization', auth());

    expect(response.body.accounts).toHaveLength(2);
    expect(response.body.totals[0].debits).toBe('10.00');
  });
});
