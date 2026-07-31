import { z } from 'zod';
import { ValidationError } from '../domain/errors.js';

/**
 * Parsing at the HTTP boundary, which is where 400 lives.
 *
 * The split between this and the schemas inside the service is the split between 400 and
 * 422. Here: is this JSON shaped like the thing it claims to be - are the fields present,
 * are they strings where strings belong. There: does what it describes make sense - does the
 * entry balance, is the account open, does the currency match.
 *
 * A client can fix a 400 by correcting its serialisation. A 422 it can only fix by asking
 * for something different. That is the whole distinction, and it is worth two parsing steps.
 */

export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  input: unknown,
  subject: 'body' | 'path' | 'query',
): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new ValidationError(
    `invalid request ${subject}: ${z.prettifyError(result.error)}`,
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
    { cause: result.error },
  );
}

/**
 * A path parameter that has to be a UUID.
 *
 * Checked before anything else touches it, because `/accounts/not-a-uuid/balance` would
 * otherwise reach Postgres and come back as `22P02 invalid input syntax for type uuid` - a
 * 500 for what is plainly a client mistake.
 */
export const uuidParam = z.uuid('must be a UUID');

export const paginationQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * `asOf` as an ISO 8601 instant.
 *
 * `z.coerce.date()` is deliberately not used here: it accepts anything `new Date()` accepts,
 * which includes `"tuesday"` in some runtimes and silently produces an Invalid Date in
 * others. A balance query is not the place to be relaxed about what a date is.
 */
export const isoDateTimeQuery = z.iso.datetime({ offset: true }).optional();
