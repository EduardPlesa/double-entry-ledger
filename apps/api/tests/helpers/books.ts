import request from 'supertest';
import type { BookRole } from '../../src/domain/policy.js';
import { STRONG_PASSWORD, uniqueEmail, type TestApplication } from './app.js';

/**
 * Fixtures built the way a client would build them: through the API.
 *
 * Seeding directly into the database would be faster and would skip the very layer these
 * tests exist to exercise. A book created through `POST /books` has an owner because the
 * service put one there, which is the fact half of these assertions depend on.
 */

export interface TestUser {
  readonly email: string;
  readonly userId: string;
  readonly accessToken: string;
}

export interface TestBook {
  readonly bookId: string;
  readonly owner: TestUser;
}

export function bearer(credential: string): string {
  return `Bearer ${credential}`;
}

export async function registerUser(application: TestApplication): Promise<TestUser> {
  const email = uniqueEmail();
  const response = await request(application.app)
    .post('/auth/register')
    .send({ email, password: STRONG_PASSWORD });

  if (response.status !== 201) {
    throw new Error(`register failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }

  return { email, userId: response.body.user.id, accessToken: response.body.accessToken };
}

export async function createBook(application: TestApplication, owner: TestUser): Promise<TestBook> {
  const response = await request(application.app)
    .post('/books')
    .set('Authorization', bearer(owner.accessToken))
    .send({ name: 'Test book', baseCurrency: 'EUR' });

  if (response.status !== 201) {
    throw new Error(`createBook failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }

  return { bookId: response.body.id, owner };
}

/** Registers someone new and grants them a role in an existing book. */
export async function addMember(
  application: TestApplication,
  book: TestBook,
  role: BookRole,
): Promise<TestUser> {
  const member = await registerUser(application);

  const response = await request(application.app)
    .post(`/books/${book.bookId}/members`)
    .set('Authorization', bearer(book.owner.accessToken))
    .send({ email: member.email, role });

  if (response.status !== 200) {
    throw new Error(`addMember failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }

  return member;
}

export async function issueApiKey(
  application: TestApplication,
  book: TestBook,
  role: BookRole,
): Promise<string> {
  const response = await request(application.app)
    .post(`/books/${book.bookId}/api-keys`)
    .set('Authorization', bearer(book.owner.accessToken))
    .send({ name: 'ci', role });

  if (response.status !== 201) {
    throw new Error(`issueApiKey failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }

  return response.body.token;
}

export async function createAccount(
  application: TestApplication,
  book: TestBook,
  overrides: { name?: string; type?: string; currency?: string; parentId?: string } = {},
): Promise<string> {
  const response = await request(application.app)
    .post(`/books/${book.bookId}/accounts`)
    .set('Authorization', bearer(book.owner.accessToken))
    .send({
      name: overrides.name ?? 'Cash',
      type: overrides.type ?? 'asset',
      currency: overrides.currency ?? 'EUR',
      ...(overrides.parentId === undefined ? {} : { parentId: overrides.parentId }),
    });

  if (response.status !== 201) {
    throw new Error(`createAccount failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }

  return response.body.id;
}
