import { formatMoney, money } from '@ledger/shared';
import fc from 'fast-check';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApplication, type TestApplication } from '../helpers/app.js';
import { bearer, createAccount, createBook, registerUser } from '../helpers/books.js';
import { HTTP_AMOUNT_EXAMPLES } from './regressions.js';
import { propertyRuns } from './runs.js';

/**
 * An amount's full trip: decimal string, bigint, numeric, bigint, decimal string.
 *
 * Stage 3's tests cover the route layer's status codes, validation and problem documents, and
 * they stay there. What no example test can cover by enumeration is that an *arbitrary* amount
 * survives this chain - and it is the one path in the system where a JS `number` could appear
 * without any single layer noticing, because every layer would still be handling a value that
 * looks entirely plausible.
 *
 * Deliberately one property. A second command harness at this layer would cost minutes per run
 * and duplicate what `ledger.property.test.ts` already asserts about the ledger itself.
 */

/**
 * Past `Number.MAX_SAFE_INTEGER`, which is 9_007_199_254_740_991: a value above it that has
 * been through a double comes back changed, and this is the range where that shows.
 *
 * Bounded at `2^63 - 1`, not an arbitrary round number: `amount_minor` is Postgres `bigint`
 * (int8), so that is the actual ceiling a posting can hold. A wider range draws values Postgres
 * rejects outright with "value out of range for type bigint" - a 500, not a precision loss -
 * which would make every later assertion in a shrunk run meaningless. This still covers the
 * entire legally representable range, right up to the true boundary.
 */
const AMOUNT_MINOR = fc.bigInt({ min: 1n, max: 2n ** 63n - 1n });

describe('an amount across the HTTP boundary', () => {
  it('round-trips through post and read, at any magnitude', async () => {
    const application: TestApplication = createTestApplication();
    const owner = await registerUser(application);
    const book = await createBook(application, owner);

    // The guarded account takes the positive leg and the unguarded one takes the negative, so
    // the overdraft rule never fires. This property is about arithmetic, not about the rule:
    // a refusal here would stop it measuring what it exists to measure.
    const debit = await createAccount(application, book, { name: 'Receivable', type: 'asset' });
    const credit = await createAccount(application, book, { name: 'Revenue', type: 'revenue' });

    // The account accumulates across cases, so the expected balance has to as well. Correct
    // only because every case posts: the sole refusal available is an overdraft, and `debit`
    // never receives a negative leg. Shrinking replays smaller amounts against a balance that
    // has already moved, which this handles and a per-case constant would not.
    let expectedMinor = 0n;

    await fc.assert(
      fc.asyncProperty(AMOUNT_MINOR, async (amountMinor) => {
        const amount = formatMoney(money(amountMinor, 'EUR'));
        const negated = formatMoney(money(-amountMinor, 'EUR'));

        const posted = await request(application.app)
          .post(`/books/${book.bookId}/entries`)
          .set('Authorization', bearer(owner.accessToken))
          .send({
            occurredAt: '2026-04-01T00:00:00.000Z',
            description: 'boundary property',
            legs: [
              { accountId: debit, amount, currency: 'EUR' },
              { accountId: credit, amount: negated, currency: 'EUR' },
            ],
          });

        expect(posted.status, JSON.stringify(posted.body)).toBe(201);
        expectedMinor += amountMinor;

        const balance = await request(application.app)
          .get(`/accounts/${debit}/balance`)
          .set('Authorization', bearer(owner.accessToken));

        expect(balance.status).toBe(200);
        expect(balance.body.balance).toBe(formatMoney(money(expectedMinor, 'EUR')));
        expect(balance.body.currency).toBe('EUR');
      }),
      // The corpus replays before anything is generated. Empty today, and free until it is not.
      { numRuns: propertyRuns(15), examples: HTTP_AMOUNT_EXAMPLES },
    );
  });
});
