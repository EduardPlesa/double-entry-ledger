import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApplication, type TestApplication } from '../helpers/app.js';
import {
  bearer,
  createBook,
  issueApiKey,
  registerUser,
  type TestBook,
  type TestUser,
} from '../helpers/books.js';

/**
 * Books over HTTP, and the one question that has to be answerable before any book is known:
 * which books does this caller have.
 */

let application: TestApplication;
let owner: TestUser;
let book: TestBook;

beforeAll(async () => {
  application = createTestApplication();
  owner = await registerUser(application);
  book = await createBook(application, owner);
});

afterAll(async () => {
  await application.close();
});

const api = () => request(application.app);
const auth = () => bearer(owner.accessToken);

describe('GET /books', () => {
  it('lists the caller\'s books with the role they hold in each', async () => {
    const response = await api().get('/books').set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: book.bookId, role: 'owner', baseCurrency: 'EUR' }),
      ]),
    );
  });

  it('does not list a book the caller is not a member of', async () => {
    const stranger = await registerUser(application);
    const response = await api().get('/books').set('Authorization', bearer(stranger.accessToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await api().get('/books');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('scopes an API key to the one book it was issued for, with the role it was issued', async () => {
    const key = await issueApiKey(application, book, 'accountant');
    const otherBook = await createBook(application, await registerUser(application));

    const response = await api().get('/books').set('Authorization', bearer(key));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ id: book.bookId, role: 'accountant', baseCurrency: 'EUR' }),
    ]);
    expect(response.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: otherBook.bookId })]),
    );
  });
});
