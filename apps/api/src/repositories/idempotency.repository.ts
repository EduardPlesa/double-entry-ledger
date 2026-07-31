import { and, eq } from 'drizzle-orm';
import type { Executor } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';

/**
 * The reservation table behind `Idempotency-Key`.
 *
 * `book_id` is part of the key, so two books cannot collide on the same caller-chosen string
 * - and a key is meaningless outside the book it was used in.
 */

export interface IdempotencyRecord {
  readonly bookId: string;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly status: number | null;
  readonly responseBody: unknown;
  readonly entryId: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface IdempotencyCompletion {
  readonly status: number;
  readonly responseBody: unknown;
  readonly entryId: string | null;
  readonly completedAt: Date;
}

export interface IdempotencyRepository {
  /**
   * Inserts the reservation, or reports that somebody already holds it.
   *
   * `ON CONFLICT DO NOTHING` rather than a read followed by a write: the whole value of this
   * table is that claiming a key is atomic, and a check-then-insert would let two concurrent
   * retries both find nothing and both proceed - which is the exact thing the header exists
   * to prevent.
   */
  reserve(
    executor: Executor,
    reservation: { bookId: string; key: string; requestFingerprint: string; createdAt: Date },
  ): Promise<boolean>;

  find(executor: Executor, bookId: string, key: string): Promise<IdempotencyRecord | null>;

  complete(
    executor: Executor,
    bookId: string,
    key: string,
    completion: IdempotencyCompletion,
  ): Promise<void>;
}

const columns = {
  bookId: idempotencyKeys.bookId,
  key: idempotencyKeys.key,
  requestFingerprint: idempotencyKeys.requestFingerprint,
  status: idempotencyKeys.status,
  responseBody: idempotencyKeys.responseBody,
  entryId: idempotencyKeys.entryId,
  createdAt: idempotencyKeys.createdAt,
  completedAt: idempotencyKeys.completedAt,
};

export class DrizzleIdempotencyRepository implements IdempotencyRepository {
  async reserve(
    executor: Executor,
    reservation: { bookId: string; key: string; requestFingerprint: string; createdAt: Date },
  ): Promise<boolean> {
    const inserted = await executor
      .insert(idempotencyKeys)
      .values(reservation)
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    return inserted.length > 0;
  }

  async find(executor: Executor, bookId: string, key: string): Promise<IdempotencyRecord | null> {
    const [record] = await executor
      .select(columns)
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.bookId, bookId), eq(idempotencyKeys.key, key)))
      .limit(1);

    return record ?? null;
  }

  /**
   * Writes the outcome back onto the reservation.
   *
   * The three completion columns move together, which the `idempotency_keys_completion_consistent`
   * CHECK insists on: a row with a status and no timestamp would read as in-flight to one
   * request and as finished to the next.
   */
  async complete(
    executor: Executor,
    bookId: string,
    key: string,
    completion: IdempotencyCompletion,
  ): Promise<void> {
    await executor
      .update(idempotencyKeys)
      .set({
        status: completion.status,
        responseBody: completion.responseBody,
        entryId: completion.entryId,
        completedAt: completion.completedAt,
      })
      .where(and(eq(idempotencyKeys.bookId, bookId), eq(idempotencyKeys.key, key)));
  }
}
