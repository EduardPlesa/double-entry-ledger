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
 * The overdraft rule as a client actually meets it: over HTTP, through the real route.
 *
 * Everything below the boundary was already covered - the service raises the error, the
 * repository finds the offending prefix, the deferred trigger catches what the service misses.
 * None of that says what a caller receives, and the answer is the part they have to program
 * against. The shortfall in particular exists only to be read by a client: it is the number
 * they have to deposit before retrying, and if it arrived as a JSON number, under a different
 * name, or not at all, every test underneath this one would still pass.
 *
 * `POST /entries` and `POST /entries/:id/reverse` are both here because they are separate
 * write paths into the same rule, and one of them used to answer differently. `reverseEntry`
 * had no SQLSTATE translation at all, so a reversal that hit the database's LG004 became an
 * unrecognised failure and a 500 for the identical condition that `postEntry` reported as a
 * 422 - hence a reversal case in this file rather than a note that it probably behaves the
 * same.
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
  /** asset, EUR. The guarded one. */
  cash: string;
  /** revenue, EUR. Not guarded, so it may go as negative as it likes. */
  sales: string;
  /** expense, EUR. Where a withdrawal goes. */
  rent: string;
}

async function freshBook(): Promise<Fixture> {
  const book = await createBook(application, owner);
  return {
    book,
    cash: await createAccount(application, book, { name: 'Cash', type: 'asset' }),
    sales: await createAccount(application, book, { name: 'Sales', type: 'revenue' }),
    rent: await createAccount(application, book, { name: 'Rent', type: 'expense' }),
  };
}

/** Money into `cash`, against revenue. Always affordable; nothing here is under test. */
async function fund(fixture: Fixture, amount: string) {
  return api()
    .post(`/books/${fixture.book.bookId}/entries`)
    .set('Authorization', auth())
    .send({
      occurredAt: '2026-01-01T00:00:00.000Z',
      description: 'opening balance',
      legs: [
        { accountId: fixture.cash, amount, currency: 'EUR' },
        { accountId: fixture.sales, amount: `-${amount}`, currency: 'EUR' },
      ],
    });
}

/** Money out of `cash`, into an expense. The thing the rule is allowed to refuse. */
async function withdraw(fixture: Fixture, amount: string, occurredAt = '2026-02-01T00:00:00.000Z') {
  return api()
    .post(`/books/${fixture.book.bookId}/entries`)
    .set('Authorization', auth())
    .send({
      occurredAt,
      description: `withdrawing ${amount}`,
      legs: [
        { accountId: fixture.cash, amount: `-${amount}`, currency: 'EUR' },
        { accountId: fixture.rent, amount, currency: 'EUR' },
      ],
    });
}

describe('POST /books/:bookId/entries against an insufficient balance', () => {
  it('answers 422 with the shortfall, the account and the instant', async () => {
    const fixture = await freshBook();
    await fund(fixture, '100.00');

    const response = await withdraw(fixture, '150.00');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('ACCOUNT_OVERDRAWN');
    expect(response.body.status).toBe(422);

    // Which account, so a client with a multi-leg entry does not have to guess which of them
    // it was.
    expect(response.body.accountId).toBe(fixture.cash);

    // A decimal string, like every other amount at this boundary. €100.00 in against €150.00
    // out reaches minus fifty, and that is what has to be deposited before this will work.
    expect(response.body.shortfall).toBe('-50.00');
    expect(typeof response.body.shortfall).toBe('string');
    expect(response.body.currency).toBe('EUR');

    // When it goes short, which is not the same question as "what is the balance now" - the
    // rule is about every prefix, so a backdated entry can be refused for a dip that is long
    // since recovered.
    expect(response.body.occurredAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('writes nothing: the balance is what it was before the refusal', async () => {
    const fixture = await freshBook();
    await fund(fixture, '100.00');

    await withdraw(fixture, '150.00');

    const balance = await api()
      .get(`/accounts/${fixture.cash}/balance`)
      .set('Authorization', auth());

    expect(balance.status).toBe(200);
    expect(balance.body.balance).toBe('100.00');
  });

  it('refuses a backdated withdrawal that only overdraws the account in the past', async () => {
    // The case a rule about the current balance would wave through. €100.00 arrives in
    // January and €500.00 in March, so today's balance is €600.00 - but a €300.00 withdrawal
    // backdated to February overdraws the account on the very date it claims to describe.
    const fixture = await freshBook();
    await fund(fixture, '100.00');

    await api()
      .post(`/books/${fixture.book.bookId}/entries`)
      .set('Authorization', auth())
      .send({
        occurredAt: '2026-03-01T00:00:00.000Z',
        description: 'a later deposit',
        legs: [
          { accountId: fixture.cash, amount: '500.00', currency: 'EUR' },
          { accountId: fixture.sales, amount: '-500.00', currency: 'EUR' },
        ],
      });

    const response = await withdraw(fixture, '300.00', '2026-02-01T00:00:00.000Z');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('ACCOUNT_OVERDRAWN');
    expect(response.body.shortfall).toBe('-200.00');
    expect(response.body.occurredAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('accepts a withdrawal for exactly the balance: zero is not negative', async () => {
    const fixture = await freshBook();
    await fund(fixture, '100.00');

    const response = await withdraw(fixture, '100.00');

    expect(response.status).toBe(201);
  });
});

describe('POST /entries/:entryId/reverse when the reversal is what overdraws', () => {
  /**
   * A reversal is not exempt from the rule, and this is the shape that proves it. €100.00 is
   * received and then spent; reversing the receipt would take that €100.00 back out of an
   * account that no longer has it, leaving the balance at minus one hundred from the moment
   * the reversal lands.
   *
   * The status is the assertion that matters. This request travels the one write path that
   * translated no SQLSTATE at all, so an untranslated database refusal here is a 500 for a
   * condition the other path reports as a 422 - the same rule, the same rejection, two
   * different answers depending on which endpoint the client happened to call.
   */
  it('answers 422 with the same shape as a refused post, not a 500', async () => {
    const fixture = await freshBook();

    const receipt = await fund(fixture, '100.00');
    expect(receipt.status).toBe(201);

    const spent = await withdraw(fixture, '100.00', '2026-02-01T00:00:00.000Z');
    expect(spent.status).toBe(201);

    const response = await api()
      .post(`/entries/${receipt.body.id}/reverse`)
      .set('Authorization', auth())
      .send({ occurredAt: '2026-03-01T00:00:00.000Z' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('ACCOUNT_OVERDRAWN');
    expect(response.body.accountId).toBe(fixture.cash);
    expect(response.body.shortfall).toBe('-100.00');
    expect(response.body.currency).toBe('EUR');
  });

  it('leaves the original entry and the balance untouched', async () => {
    const fixture = await freshBook();

    const receipt = await fund(fixture, '100.00');
    await withdraw(fixture, '100.00');

    await api()
      .post(`/entries/${receipt.body.id}/reverse`)
      .set('Authorization', auth())
      .send({ occurredAt: '2026-03-01T00:00:00.000Z' });

    const balance = await api()
      .get(`/accounts/${fixture.cash}/balance`)
      .set('Authorization', auth());

    expect(balance.body.balance).toBe('0.00');

    // And the refusal did not consume the entry's one reversal: fund the account and the same
    // correction goes through, which is what the error was telling the caller to do.
    await fund(fixture, '100.00');

    const retried = await api()
      .post(`/entries/${receipt.body.id}/reverse`)
      .set('Authorization', auth())
      .send({ occurredAt: '2026-03-01T00:00:00.000Z' });

    expect(retried.status).toBe(201);
  });
});
