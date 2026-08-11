import {
  accountResource,
  balanceResource,
  bookResource,
  entryResource,
  postingPageResource,
  trialBalanceResource,
} from '@ledger/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApplication, type TestApplication } from '../helpers/app.js';
import { bearer, createAccount, createBook, registerUser, type TestBook, type TestUser } from '../helpers/books.js';

/**
 * Every response this API sends parses against the schema the spec publishes for it.
 *
 * The application does not parse its own responses - `responses.ts` explains why, and that
 * argument still holds. This is where the schemas get verified instead: if a handler adds a
 * field, or serialises an amount as a number, the spec is wrong and this fails. Without it
 * the schemas would be a second declaration of the same shape, free to drift from the first.
 */

let application: TestApplication;
let owner: TestUser;
let book: TestBook;
let cash: string;
let sales: string;
let entryId: string;

beforeAll(async () => {
  application = createTestApplication();
  owner = await registerUser(application);
  book = await createBook(application, owner);
  cash = await createAccount(application, book, { name: 'Cash', type: 'asset' });
  sales = await createAccount(application, book, { name: 'Sales', type: 'revenue' });

  const entry = await api()
    .post(`/books/${book.bookId}/entries`)
    .set('Authorization', auth())
    .send({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      legs: [
        { accountId: cash, amount: '10.00', currency: 'EUR' },
        { accountId: sales, amount: '-10.00', currency: 'EUR' },
      ],
    });

  if (entry.status !== 201) {
    throw new Error(`seeding the entry failed: ${String(entry.status)} ${JSON.stringify(entry.body)}`);
  }

  entryId = entry.body.id;
});

afterAll(async () => {
  await application.close();
});

const api = () => request(application.app);
const auth = () => bearer(owner.accessToken);

/**
 * The mismatch, or the empty string.
 *
 * `expect(() => schema.parse(body)).not.toThrow()` reports that something threw and not what,
 * which on a response with a dozen fields is a failure you have to reproduce by hand. This
 * puts the offending path and message in the assertion itself.
 */
function mismatch(schema: z.ZodType, value: unknown): string {
  const result = schema.safeParse(value);
  return result.success ? '' : z.prettifyError(result.error);
}

describe('the published response schemas', () => {
  it('describe GET /books', async () => {
    const response = await api().get('/books').set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(mismatch(z.array(bookResource), response.body)).toBe('');
  });

  it('describe POST /books', async () => {
    const response = await api()
      .post('/books')
      .set('Authorization', auth())
      .send({ name: 'Second book', baseCurrency: 'EUR' });

    expect(response.status).toBe(201);
    expect(mismatch(bookResource, response.body)).toBe('');
  });

  it('describe the accounts of a book', async () => {
    const response = await api().get(`/books/${book.bookId}/accounts`).set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(mismatch(z.array(accountResource), response.body)).toBe('');
  });

  it('describe a created account, parent and closure included', async () => {
    const response = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', auth())
      .send({ name: 'Petty cash', type: 'asset', currency: 'EUR', parentId: cash });

    expect(response.status).toBe(201);
    expect(mismatch(accountResource, response.body)).toBe('');
  });

  it('describe an entry, with its postings', async () => {
    const response = await api().get(`/entries/${entryId}`).set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(mismatch(entryResource, response.body)).toBe('');
  });

  it('describe a reversal, which is an entry like any other', async () => {
    const original = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send({
        occurredAt: '2026-03-02T12:00:00.000Z',
        description: 'a sale to undo',
        legs: [
          { accountId: cash, amount: '4.00', currency: 'EUR' },
          { accountId: sales, amount: '-4.00', currency: 'EUR' },
        ],
      });

    const response = await api()
      .post(`/entries/${original.body.id}/reverse`)
      .set('Authorization', auth())
      .send({ description: 'undone' });

    expect(response.status).toBe(201);
    expect(mismatch(entryResource, response.body)).toBe('');
  });

  it('describe a balance', async () => {
    const response = await api().get(`/accounts/${cash}/balance`).set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(mismatch(balanceResource, response.body)).toBe('');
  });

  it('describe a balance asked for as of a point in time', async () => {
    // `asOf` is the one field on this resource that is ever non-null, so a schema that had it
    // wrong would still pass the case above.
    const response = await api()
      .get(`/accounts/${cash}/balance`)
      .query({ asOf: '2026-03-01T23:00:00.000Z' })
      .set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(mismatch(balanceResource, response.body)).toBe('');
  });

  it('describe a trial balance', async () => {
    const response = await api()
      .get(`/books/${book.bookId}/trial-balance`)
      .set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(mismatch(trialBalanceResource, response.body)).toBe('');
  });

  it('describe a page of postings', async () => {
    const response = await api()
      .get(`/accounts/${cash}/postings`)
      .query({ limit: 1 })
      .set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(mismatch(postingPageResource, response.body)).toBe('');

    // A page of one out of several, so `nextCursor` is a string here rather than the null the
    // unpaged case returns.
    expect(response.body.nextCursor).not.toBeNull();
  });
});
