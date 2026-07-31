import { newId } from '@ledger/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApplication, type TestApplication } from '../helpers/app.js';
import {
  addMember,
  bearer,
  createAccount,
  createBook,
  issueApiKey,
  registerUser,
  type TestBook,
  type TestUser,
} from '../helpers/books.js';

/**
 * Authorization, exercised through HTTP against a real database.
 *
 * The two properties worth most of the attention here are the ones that are easy to get
 * subtly wrong and impossible to notice afterwards: a non-member sees 404 rather than 403, so
 * membership cannot be enumerated with an id and a stopwatch; and an API key scoped to one
 * book is treated as a stranger everywhere else.
 */

let application: TestApplication;
let owner: TestUser;
let book: TestBook;
let accountId: string;

beforeAll(async () => {
  application = createTestApplication();
  owner = await registerUser(application);
  book = await createBook(application, owner);
  accountId = await createAccount(application, book);
});

afterAll(async () => {
  await application.close();
});

const api = () => request(application.app);

describe('authentication', () => {
  it('refuses a request with no credential', async () => {
    const response = await api().post('/books').send({ name: 'x', baseCurrency: 'EUR' });

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a token that is not one of ours, without saying why', async () => {
    const bogus = await api()
      .post('/books')
      .set('Authorization', bearer('not.a.token'))
      .send({ name: 'x', baseCurrency: 'EUR' });

    expect(bogus.status).toBe(401);
    expect(bogus.body.detail).toBe('authentication is required');
  });

  it('accepts the scheme in any case, as the RFC requires', async () => {
    const response = await api()
      .post('/books')
      .set('Authorization', `bearer ${owner.accessToken}`)
      .send({ name: 'Lowercase scheme', baseCurrency: 'EUR' });

    expect(response.status).toBe(201);
  });

  it('refuses an expired access token', async () => {
    application.clock.set(new Date(Date.now() + 60 * 60 * 1000));
    const response = await api().post('/books').set('Authorization', bearer(owner.accessToken)).send({
      name: 'x',
      baseCurrency: 'EUR',
    });
    application.clock.set(new Date('2026-03-31T09:00:00.000Z'));

    expect(response.status).toBe(401);
  });
});

describe('POST /books', () => {
  it('creates a book with Location, and makes the caller its owner', async () => {
    const response = await api()
      .post('/books')
      .set('Authorization', bearer(owner.accessToken))
      .send({ name: 'Household', baseCurrency: 'EUR' });

    expect(response.status).toBe(201);
    expect(response.headers.location).toBe(`/books/${response.body.id}`);

    // Owner, established by the fact that a member:manage operation succeeds.
    const asOwner = await api()
      .post(`/books/${response.body.id}/api-keys`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ name: 'ci', role: 'viewer' });

    expect(asOwner.status).toBe(201);
  });

  it('rejects a currency that is not an ISO code', async () => {
    const response = await api()
      .post('/books')
      .set('Authorization', bearer(owner.accessToken))
      .send({ name: 'Household', baseCurrency: 'euro' });

    expect(response.status).toBe(400);
    expect(response.body.errors).toContainEqual({
      path: 'baseCurrency',
      message: 'must be a three-letter ISO 4217 code, such as EUR',
    });
  });
});

describe('a caller who is not a member', () => {
  it('gets 404, not 403, for a book that exists', async () => {
    // The distinction that matters. A 403 would confirm the book is real, which turns any id
    // into a membership oracle.
    const stranger = await registerUser(application);

    const response = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', bearer(stranger.accessToken))
      .send({ name: 'Cash', type: 'asset', currency: 'EUR' });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('BOOK_NOT_FOUND');
  });

  it('gets the same answer for a book that does not exist at all', async () => {
    const stranger = await registerUser(application);
    const real = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', bearer(stranger.accessToken))
      .send({ name: 'Cash', type: 'asset', currency: 'EUR' });

    const imaginary = await api()
      .post(`/books/${newId()}/accounts`)
      .set('Authorization', bearer(stranger.accessToken))
      .send({ name: 'Cash', type: 'asset', currency: 'EUR' });

    expect(imaginary.status).toBe(real.status);
    expect(imaginary.body.code).toBe(real.body.code);
    expect(imaginary.body.title).toBe(real.body.title);
  });

  it('cannot read an account through its own id either', async () => {
    // The account id is a real one in a real book. Resolving it to a book is allowed - that is
    // what the lookup function is for - and the membership check is what stops there.
    const stranger = await registerUser(application);

    const response = await api()
      .get(`/accounts/${accountId}/balance`)
      .set('Authorization', bearer(stranger.accessToken));

    expect(response.status).toBe(404);
  });
});

describe('roles', () => {
  it('lets an accountant post entries but not manage members', async () => {
    const accountant = await addMember(application, book, 'accountant');

    const posting = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', bearer(accountant.accessToken))
      .send({ name: 'Sales', type: 'revenue', currency: 'EUR' });

    const managing = await api()
      .post(`/books/${book.bookId}/members`)
      .set('Authorization', bearer(accountant.accessToken))
      .send({ email: owner.email, role: 'viewer' });

    expect(posting.status).toBe(201);
    expect(managing.status).toBe(403);
    expect(managing.body.code).toBe('FORBIDDEN');
  });

  it('tells a member honestly that their role is not enough', async () => {
    // 403 here, unlike the non-member case, because there is nothing left to conceal: the
    // caller already knows the book exists and that they are in it.
    const viewer = await addMember(application, book, 'viewer');

    const response = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', bearer(viewer.accessToken))
      .send({ name: 'Cash', type: 'asset', currency: 'EUR' });

    expect(response.status).toBe(403);
    expect(response.body.detail).toContain('viewer');
    expect(response.body.detail).toContain('account:create');
  });

  it('lets a viewer read', async () => {
    const viewer = await addMember(application, book, 'viewer');

    const response = await api()
      .get(`/accounts/${accountId}/balance`)
      .set('Authorization', bearer(viewer.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.balance).toBe('0.00');
  });

  it('changes a role in place rather than adding a second one', async () => {
    const member = await addMember(application, book, 'viewer');

    const promoted = await api()
      .post(`/books/${book.bookId}/members`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ email: member.email, role: 'accountant' });

    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('accountant');

    const nowAllowed = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', bearer(member.accessToken))
      .send({ name: 'Bank', type: 'asset', currency: 'EUR' });

    expect(nowAllowed.status).toBe(201);
  });

  it('refuses to grant a role to somebody who has not registered', async () => {
    const response = await api()
      .post(`/books/${book.bookId}/members`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ email: 'nobody@example.test', role: 'viewer' });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('USER_NOT_FOUND');
  });

  it('refuses a role the policy map has never heard of', async () => {
    const response = await api()
      .post(`/books/${book.bookId}/members`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ email: owner.email, role: 'admin' });

    expect(response.status).toBe(400);
  });
});

describe('API keys', () => {
  it('are returned once, with a prefix that identifies without authenticating', async () => {
    const response = await api()
      .post(`/books/${book.bookId}/api-keys`)
      .set('Authorization', bearer(owner.accessToken))
      .send({ name: 'ci', role: 'accountant' });

    expect(response.status).toBe(201);
    expect(response.body.token).toMatch(/^lk_test_/);
    expect(response.body.prefix).toHaveLength('lk_test_'.length + 6);
    expect(response.body.token.startsWith(response.body.prefix)).toBe(true);
  });

  it('authenticate on the same header as an access token', async () => {
    const key = await issueApiKey(application, book, 'accountant');

    const response = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', bearer(key))
      .send({ name: 'Machine account', type: 'asset', currency: 'EUR' });

    expect(response.status).toBe(201);
  });

  it('carry their own role, and are held to it', async () => {
    const key = await issueApiKey(application, book, 'viewer');

    const response = await api()
      .post(`/books/${book.bookId}/accounts`)
      .set('Authorization', bearer(key))
      .send({ name: 'Nope', type: 'asset', currency: 'EUR' });

    expect(response.status).toBe(403);
  });

  it('are a stranger in any other book', async () => {
    // The blast radius of a leaked key is one book, and this is what makes that true.
    const other = await createBook(application, await registerUser(application));
    const key = await issueApiKey(application, book, 'owner');

    const response = await api()
      .post(`/books/${other.bookId}/accounts`)
      .set('Authorization', bearer(key))
      .send({ name: 'Cross-book', type: 'asset', currency: 'EUR' });

    expect(response.status).toBe(404);
  });

  it('cannot create a book, whatever their role', async () => {
    // Not a permission question: a key is scoped to one book, so a second one would either
    // escape that scope or be unreachable.
    const key = await issueApiKey(application, book, 'owner');

    const response = await api()
      .post('/books')
      .set('Authorization', bearer(key))
      .send({ name: 'Machine book', baseCurrency: 'EUR' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('API_KEY_NOT_PERMITTED');
  });

  it('record when they were last used', async () => {
    const key = await issueApiKey(application, book, 'viewer');

    await api().get(`/accounts/${accountId}/balance`).set('Authorization', bearer(key));

    const { rows } = await application.pool.query<{ last_used_at: Date | null }>(
      'SELECT last_used_at FROM api_keys WHERE prefix = $1',
      [key.slice(0, 'lk_test_'.length + 6)],
    );

    expect(rows[0]?.last_used_at).not.toBeNull();
  });
});

describe('path parameters', () => {
  it('are rejected as malformed before they reach the database', async () => {
    // Otherwise Postgres answers `22P02 invalid input syntax for type uuid`, which is a 500
    // for what is plainly a client mistake.
    const response = await api()
      .get('/accounts/not-a-uuid/balance')
      .set('Authorization', bearer(owner.accessToken));

    expect(response.status).toBe(400);
    expect(response.body.errors).toContainEqual({ path: 'accountId', message: 'must be a UUID' });
  });

  it('give 404 for a well-formed id that names nothing', async () => {
    const response = await api()
      .get(`/accounts/${newId()}/balance`)
      .set('Authorization', bearer(owner.accessToken));

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('ACCOUNT_NOT_FOUND');
  });
});
