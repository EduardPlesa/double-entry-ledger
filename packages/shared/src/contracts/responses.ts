import { z } from 'zod';
import { accountType } from './requests.js';
import { BOOK_ROLES } from './roles.js';

/**
 * The shape of every JSON resource this API returns.
 *
 * Schemas since stage 7, and they were types before. What changed is not the argument: a
 * runtime parse at the client boundary would still catch a server-side shape change as an
 * error instead of as `undefined` in a cell, and it would still cost a parse per response
 * against a server in this same repository, typechecked by this same command. The
 * application does not parse its own responses and nothing here asks it to.
 *
 * What changed is that the OpenAPI document has to describe these shapes, and a document
 * generated from a hand-written copy of a TypeScript interface is a second declaration free
 * to drift from the first. A schema is a value, so `openapi/document.ts` can read it. The
 * types below are `z.infer` of the schemas, which makes the two impossible to disagree, and
 * `tests/http/contracts.test.ts` is where real responses are checked against them.
 *
 * Three conventions hold throughout, and `serialize.ts` explains why: amounts are decimal
 * strings, posting ids are strings because a bigserial outruns `Number.MAX_SAFE_INTEGER`,
 * and timestamps are ISO 8601 with an offset.
 */

/**
 * An amount as `formatMoney` writes it: an optional minus, digits, and a fraction as long as
 * the currency's minor unit - two places for EUR, three for KWD, none at all for JPY, which
 * is why the fractional part is optional rather than fixed at two.
 */
export const moneyString = z
  .string()
  .regex(/^-?\d+(?:\.\d{2,3})?$/)
  .describe('A decimal string. Never a JSON number: a JSON number is an IEEE 754 double.');

/** A bigserial, as a string. Past 2^53 a JavaScript client would round it without noticing. */
export const postingId = z.string().regex(/^\d+$/);

const currencyCode = z.string().regex(/^[A-Z]{3}$/).describe('An ISO 4217 code, such as EUR.');

const timestamp = z.iso.datetime({ offset: true });

export const bookResource = z.object({
  id: z.uuid(),
  name: z.string(),
  baseCurrency: currencyCode,
  createdAt: timestamp,
  role: z
    .enum(BOOK_ROLES)
    .describe(
      "The caller's role in this book. Present so the UI can stop offering what the policy " +
        'forbids - a viewer should not be shown a compose button that always ends in a 403. ' +
        'The server still decides; this only lets the client stop asking.',
    ),
});

export type BookResource = z.infer<typeof bookResource>;

export const accountResource = z.object({
  id: z.uuid(),
  bookId: z.uuid(),
  name: z.string(),
  type: accountType,
  currency: currencyCode,
  parentId: z
    .uuid()
    .nullable()
    .describe('Null for a root account. The tree the frontend draws is built from this column.'),
  closedAt: timestamp.nullable(),
});

export type AccountResource = z.infer<typeof accountResource>;

export const entryResource = z.object({
  id: z.uuid(),
  bookId: z.uuid(),
  occurredAt: timestamp,
  recordedAt: timestamp,
  description: z.string(),
  externalId: z.string().nullable(),
  reversalOf: z.uuid().nullable(),
  reversedBy: z
    .uuid()
    .nullable()
    .describe(
      'The reversal of this entry, where one exists. The inverse of `reversalOf`, and the ' +
        'only way a caller can know an entry is already reversed without attempting the ' +
        'reversal and reading `ENTRY_ALREADY_REVERSED` off the failure.',
    ),
  postings: z.array(
    z.object({
      id: postingId,
      accountId: z.uuid(),
      amount: moneyString,
      currency: currencyCode,
    }),
  ),
});

export type EntryResource = z.infer<typeof entryResource>;

export const balanceResource = z.object({
  accountId: z.uuid(),
  asOf: timestamp.nullable().describe('The instant asked for, or null for the balance as of now.'),
  balance: moneyString,
  currency: currencyCode,
});

export type BalanceResource = z.infer<typeof balanceResource>;

export const trialBalanceResource = z.object({
  bookId: z.uuid(),
  asOf: timestamp.nullable(),
  accounts: z.array(
    z.object({
      accountId: z.uuid(),
      name: z.string(),
      type: accountType,
      currency: currencyCode,
      balance: moneyString,
    }),
  ),
  totals: z.array(
    z.object({
      currency: currencyCode,
      debits: moneyString,
      credits: moneyString,
      balanced: z.boolean(),
    }),
  ),
  balanced: z
    .boolean()
    .describe('False means this book does not add up, which is a fact about the data, not a query error.'),
});

export type TrialBalanceResource = z.infer<typeof trialBalanceResource>;

export const postingPageResource = z.object({
  accountId: z.uuid(),
  items: z.array(
    z.object({
      id: postingId,
      entryId: z.uuid(),
      occurredAt: timestamp,
      recordedAt: timestamp,
      description: z.string(),
      amount: moneyString,
      runningBalance: moneyString.describe('The account balance through this posting, computed by the server.'),
      currency: currencyCode,
    }),
  ),
  nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page. Null on the last one.'),
});

export type PostingPageResource = z.infer<typeof postingPageResource>;
