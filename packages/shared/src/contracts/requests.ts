import { z } from 'zod';

/**
 * Every request shape, in one place, imported by the service that enforces it and by the
 * client that has to satisfy it.
 *
 * These lived in the services until stage 6, because nothing outside them had an opinion.
 * The frontend does: the composer greys out submit on exactly the rule `postEntryInput`
 * states, and a second copy of that rule would eventually disagree with this one - silently,
 * and in the direction of offering the user a button that cannot work.
 *
 * What is here is shape only. Whether the account is open, whether the currencies match,
 * whether the entry overdraws anything are questions about the database, and they stay in
 * the service. That is the same 400-versus-422 split `http/validate.ts` describes.
 */

const CURRENCY_RE = /^[A-Z]{3}$/;

const currency = z
  .string()
  .regex(CURRENCY_RE, 'must be a three-letter ISO 4217 code, such as EUR');

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'must be an email address');

/**
 * The upper bound is not a strength consideration - it is there because the password is fed
 * to a deliberately expensive hash, and an unbounded one lets a caller choose how much CPU
 * this process spends on their request.
 */
const passwordSchema = z.string().min(12, 'must be at least 12 characters').max(1024);

export const credentials = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export type CredentialsInput = z.input<typeof credentials>;

export const createBookInput = z.object({
  name: z.string().trim().min(1, 'must not be blank').max(200),
  baseCurrency: currency,
});

export type CreateBookInput = z.input<typeof createBookInput>;

/**
 * The five account types of double-entry bookkeeping, matching the Postgres enum. Fixed by
 * accounting rather than by product requirements - there will never be a sixth.
 */
export const accountType = z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']);

/** The account-tree screen groups by this; exported so it can name the union, not five strings. */
export type AccountType = z.infer<typeof accountType>;

export const createAccountInput = z.object({
  name: z.string().trim().min(1, 'must not be blank').max(200),
  type: accountType,
  currency,
  parentId: z.uuid('must be a UUID').nullish(),
});

export type CreateAccountInput = z.input<typeof createAccountInput>;

/**
 * Amounts cross this boundary as decimal strings - `"12.34"`, not `1234` and not `12.34` as
 * a JSON number - and are minor-unit bigints from here inward. Strings because JSON numbers
 * are IEEE 754 doubles, and a ledger that can hold a value it cannot round-trip through its
 * own API is not one you would put money in. Decimal rather than minor units because the
 * caller then does not have to know that JPY has no minor unit and KWD has three; that table
 * lives in `money.ts`, next door, and both sides import it.
 */
const legInput = z.object({
  accountId: z.uuid('must be a UUID'),
  amount: z.string(),
  currency,
});

export const postEntryInput = z.object({
  /** When it happened in the world. Asserted by the caller; never read from the clock. */
  occurredAt: z.coerce.date(),
  description: z.string().trim().min(1, 'must not be blank').max(1000),
  /**
   * Caller-supplied idempotency key. Unique per book, and the reason posting the same entry
   * twice is safe.
   */
  externalId: z.string().trim().min(1, 'must not be blank').max(255).nullish(),
  /**
   * Two legs minimum. A single-leg entry cannot sum to zero unless the leg is zero, and a
   * zero leg is rejected as well - so the alternative to this bound is a worse error message
   * later, never an accepted entry.
   */
  legs: z.array(legInput).min(2, 'an entry needs at least two legs').max(1000),
});

export type PostEntryInput = z.input<typeof postEntryInput>;

/**
 * Everything about a reversal is optional. The legs are determined by the original - that is
 * what makes it a reversal rather than a new entry that happens to look like one.
 */
export const reverseEntryInput = z.object({
  occurredAt: z.coerce.date().optional(),
  description: z.string().trim().min(1, 'must not be blank').max(1000).optional(),
  externalId: z.string().trim().min(1, 'must not be blank').max(255).nullish(),
});

export type ReverseEntryInput = z.input<typeof reverseEntryInput>;

/**
 * Two pagination schemas, deliberately, because they answer different questions.
 *
 * `paginationQuery` is the HTTP boundary: is this query string shaped like pagination. It
 * has no default, because "the caller did not say" and "the caller said 50" are different
 * facts and only the service gets to turn the first into the second.
 */
export const paginationQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** The service's own input, where the default lives. */
export const listPostingsInput = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ListPostingsOptions = z.input<typeof listPostingsInput>;
