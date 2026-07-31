import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPLAYED_HEADER } from '../../src/middleware/idempotency.js';
import { createTestApplication, type TestApplication } from '../helpers/app.js';
import {
  bearer,
  createAccount,
  createBook,
  registerUser,
  type TestBook,
  type TestUser,
} from '../helpers/books.js';
import { withBookClient } from '../helpers/ledger.js';

/**
 * `Idempotency-Key`, against a real database.
 *
 * The distinction being tested throughout is between this and `external_id`. `external_id`
 * dedupes the entry: post the same one twice and there is still one entry. This dedupes the
 * HTTP call: retry the same request and get back the same response, byte for byte, including
 * when the first attempt was refused and created nothing at all.
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

let keyCounter = 0;
const uniqueKey = () => `key-${String(Date.now())}-${String(keyCounter++)}`;

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

/**
 * Counts entries by description, through a book context.
 *
 * `entries` is behind a row-level security policy keyed on `app.current_book_id`. A bare pool
 * query sees no rows at all - not an error, just nothing - so a count run without a context
 * reports zero and the assertion passes for entirely the wrong reason. `idempotency_keys` has
 * no policy, which is why the reservation queries below are plain pool queries.
 */
async function countEntriesDescribed(bookId: string, description: string): Promise<{ n: string }[]> {
  const result = await withBookClient(application.pool, bookId, (client) =>
    client.query<{ n: string }>('SELECT count(*)::text AS n FROM entries WHERE description = $1', [
      description,
    ]),
  );

  return result.rows;
}

/** Waits for the reservation to be written back, which happens after the response is sent. */
async function completed(key: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await application.pool.query<{ completed_at: Date | null }>(
      'SELECT completed_at FROM idempotency_keys WHERE key = $1',
      [key],
    );
    if (rows[0]?.completed_at != null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`reservation for ${key} was never completed`);
}

describe('a request with no Idempotency-Key', () => {
  it('is served normally and reserves nothing', async () => {
    const response = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .send(sale());

    expect(response.status).toBe(201);
    expect(response.headers[REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
  });
});

describe('a retried request', () => {
  it('replays the original response rather than acting twice', async () => {
    const key = uniqueKey();

    const first = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(sale({ description: 'the first attempt' }));

    await completed(key);

    const second = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(sale({ description: 'the first attempt' }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers[REPLAYED_HEADER.toLowerCase()]).toBe('true');
  });

  it('creates exactly one entry, even though the entry had no external id', async () => {
    // Without the header this would be two entries: the ledger has no reason to think two
    // identical-looking entries are the same one, and it is right not to.
    const key = uniqueKey();
    const description = `unique-${key}`;

    await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(sale({ description }));

    await completed(key);

    await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(sale({ description }));

    // Through a book context: entries is behind a row-level security policy, and a bare
    // pool query would see nothing and cheerfully report zero.
    const rows = await countEntriesDescribed(book.bookId, description);

    expect(rows[0]?.n).toBe('1');
  });

  it('replays a refusal too, not just a success', async () => {
    // The case `external_id` cannot cover: the first attempt created nothing, so there is no
    // entry to deduplicate against, and a retry would otherwise be a fresh 422 - which is the
    // same answer, but arrived at by doing the work again.
    const key = uniqueKey();
    const unbalanced = sale({
      legs: [
        { accountId: cash, amount: '10.00', currency: 'EUR' },
        { accountId: sales, amount: '-9.99', currency: 'EUR' },
      ],
    });

    const first = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(unbalanced);

    await completed(key);

    const second = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(unbalanced);

    expect(first.status).toBe(422);
    expect(second.status).toBe(422);
    expect(second.headers[REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(second.body.code).toBe('ENTRY_UNBALANCED');
  });

  it('links the reservation to the entry it produced', async () => {
    const key = uniqueKey();

    const response = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(sale());

    await completed(key);

    const { rows } = await application.pool.query<{ entry_id: string | null }>(
      'SELECT entry_id FROM idempotency_keys WHERE key = $1',
      [key],
    );

    expect(rows[0]?.entry_id).toBe(response.body.id);
  });
});

describe('the same key for a different request', () => {
  it('is refused as a client bug rather than answered with the first response', async () => {
    // Replaying here would hand back the result of a request the caller did not make, which
    // hides the bug behind a plausible answer.
    const key = uniqueKey();

    await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(sale({ description: 'the original' }));

    await completed(key);

    const different = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(sale({ description: 'something else entirely' }));

    expect(different.status).toBe(422);
    expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('notices a change anywhere in the body, not just the obvious fields', async () => {
    const key = uniqueKey();

    await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(sale());

    await completed(key);

    const cheaper = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(
        sale({
          legs: [
            { accountId: cash, amount: '9.00', currency: 'EUR' },
            { accountId: sales, amount: '-9.00', currency: 'EUR' },
          ],
        }),
      );

    expect(cheaper.status).toBe(422);
    expect(cheaper.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('two requests with one key at the same time', () => {
  it('serves one and tells the other it is in flight', async () => {
    const key = uniqueKey();
    const body = sale({ description: `concurrent-${key}` });

    const [first, second] = await Promise.all([
      api()
        .post(`/books/${book.bookId}/entries`)
        .set('Authorization', auth())
        .set('Idempotency-Key', key)
        .send(body),
      api()
        .post(`/books/${book.bookId}/entries`)
        .set('Authorization', auth())
        .set('Idempotency-Key', key)
        .send(body),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);

    // 409 for the loser: a request with this key is running, and the answer is not known yet.
    // The alternative - waiting for the first to finish - turns a retry into a request that
    // holds a connection open for as long as the original takes.
    expect(statuses).toEqual([201, 409]);

    const rows = await countEntriesDescribed(book.bookId, `concurrent-${key}`);
    expect(rows[0]?.n).toBe('1');
  });
});

describe('keys are scoped to their book', () => {
  it('does not collide across books', async () => {
    // The reservation is keyed on (book_id, key), so two callers picking the same string in
    // different books are not retrying each other's request.
    const other = await createBook(application, owner);
    const otherCash = await createAccount(application, other, { name: 'Cash' });
    const otherSales = await createAccount(application, other, { name: 'Sales', type: 'revenue' });

    const key = uniqueKey();

    const first = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send(sale());

    const second = await api()
      .post(`/books/${other.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', key)
      .send({
        occurredAt: '2026-03-01T12:00:00.000Z',
        description: 'a different book entirely',
        legs: [
          { accountId: otherCash, amount: '10.00', currency: 'EUR' },
          { accountId: otherSales, amount: '-10.00', currency: 'EUR' },
        ],
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });
});

describe('the header itself', () => {
  it('is rejected when blank or absurdly long', async () => {
    const blank = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', '   ')
      .send(sale());

    const enormous = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', 'x'.repeat(300))
      .send(sale());

    expect(blank.status).toBe(400);
    expect(enormous.status).toBe(400);
  });

  it('is ignored on a read, which is already idempotent', async () => {
    const response = await api()
      .get(`/accounts/${cash}/balance`)
      .set('Authorization', auth())
      .set('Idempotency-Key', uniqueKey());

    expect(response.status).toBe(200);
    expect(response.headers[REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
  });
});

describe('idempotency and external_id together', () => {
  it('are complementary: one dedupes the call, the other dedupes the entry', async () => {
    // Same entry, two different HTTP calls with different keys. The transport layer sees two
    // distinct requests and lets both through; `external_id` is what makes the second a
    // replay of the first at the domain level, answered with 200 rather than 201.
    const externalId = `invoice-${uniqueKey()}`;

    const first = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', uniqueKey())
      .send(sale({ externalId }));

    const second = await api()
      .post(`/books/${book.bookId}/entries`)
      .set('Authorization', auth())
      .set('Idempotency-Key', uniqueKey())
      .send(sale({ externalId }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);

    // Not a transport replay: this response was produced by running the request, not by
    // reading a stored one.
    expect(second.headers[REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
  });
});
