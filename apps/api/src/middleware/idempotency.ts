import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Clock } from '@ledger/shared';
import type { UnitOfWork } from '../db/client.js';
import {
  IdempotencyKeyInFlightError,
  IdempotencyKeyReusedError,
  ValidationError,
  type DomainErrorCode,
} from '../domain/errors.js';
import { bookAccessOf } from '../http/context.js';
import type { IdempotencyRepository } from '../repositories/idempotency.repository.js';

/**
 * `Idempotency-Key`: transport-level replay protection.
 *
 * Complementary to `external_id`, not a duplicate of it. `external_id` makes recording the
 * same entry twice a no-op no matter how the request arrived; this makes retrying the same
 * HTTP call return the same HTTP response - including for calls that create nothing, and
 * including the 422 the first attempt received. A client that times out and retries has no
 * idea which of those two situations it is in, which is exactly why it needs both.
 *
 * With one exception, and `isReplayable` is where it is argued: an outcome that depends on the
 * state of the ledger rather than on the request is not cached, because replaying it would
 * pin an answer that has since stopped being true.
 *
 * The reservation is inserted before the handler runs and committed on its own connection, so
 * it survives the handler's transaction rolling back. A reservation that vanished with the
 * failure it was recording would leave nothing to replay.
 */

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotency-Replayed';

/** Long enough to be unguessable if a client wants it to be; short enough to index. */
const MAX_KEY_LENGTH = 255;

/**
 * How long an unfinished reservation is believed.
 *
 * A process that dies mid-handler leaves a row that is neither complete nor abandoned, and
 * nothing can delete it - this system has no DELETE grant on anything. Without a window, that
 * key answers 409 forever. After it, a later request assumes the previous attempt is not
 * coming back and runs again. Two of them could overlap, which is a fair price for a case
 * that only arises after a crash.
 */
const ABANDONED_AFTER_MS = 60_000;

export interface IdempotencyDependencies {
  readonly repository: IdempotencyRepository;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

export function createIdempotency(dependencies: IdempotencyDependencies): RequestHandler {
  const { repository, unitOfWork, clock } = dependencies;

  return async (request, response, next) => {
    const key = keyOf(request);
    if (key === null) {
      next();
      return;
    }

    const { bookId } = bookAccessOf(response);
    const fingerprint = fingerprintOf(request);
    const now = clock.now();

    const reserved = await repository.reserve(unitOfWork.executor, {
      bookId,
      key,
      requestFingerprint: fingerprint,
      createdAt: now,
    });

    if (!reserved) {
      const existing = await repository.find(unitOfWork.executor, bookId, key);

      // Gone between the conflict and the read. Nothing can delete these rows, so this cannot
      // happen - and if it ever does, running the request is the safe reading.
      if (existing !== null) {
        // The same key for a different request is a client bug. Replaying the first response
        // would hand back the result of a request they did not make, which hides the bug
        // behind a plausible answer.
        if (existing.requestFingerprint !== fingerprint) throw new IdempotencyKeyReusedError(key);

        if (existing.completedAt !== null) {
          if (isReplayable(existing.status, existing.responseBody)) {
            replay(response, existing.status, existing.responseBody);
            return;
          }
        } else if (now.getTime() - existing.createdAt.getTime() < ABANDONED_AFTER_MS) {
          throw new IdempotencyKeyInFlightError(key);
        }
      }
    }

    captureAndComplete({ repository, unitOfWork, clock }, response, bookId, key);
    next();
  };
}

/**
 * The id of the entry a request created, for the audit trail.
 *
 * Set by the handler rather than sniffed out of the response body. A middleware inspecting
 * `body.id` and hoping it is an entry would be right until the day a route returns something
 * else with an `id`.
 */
export function recordIdempotentEntry(response: Response, entryId: string): void {
  (response.locals as { idempotentEntryId?: string }).idempotentEntryId = entryId;
}

/**
 * Captures the response body and writes the outcome back onto the reservation.
 *
 * `res.json` is patched for this request only. The alternative - buffering the whole response
 * through a stream wrapper - would intercept every write in the process for the sake of one
 * header that is usually absent.
 *
 * The write happens on `finish`, so it is after the client already has the response. There is
 * a window, measured in milliseconds, where a retry arriving before the write lands sees an
 * incomplete reservation and gets a 409. That is a correct answer to "a request with this key
 * is in flight", so the window costs accuracy rather than correctness.
 */
function captureAndComplete(
  dependencies: IdempotencyDependencies,
  response: Response,
  bookId: string,
  key: string,
): void {
  const originalJson = response.json.bind(response);
  let captured: unknown;

  response.json = (body: unknown) => {
    captured = body;
    return originalJson(body);
  };

  response.on('finish', () => {
    const { idempotentEntryId } = response.locals as { idempotentEntryId?: string };

    void dependencies.repository
      .complete(dependencies.unitOfWork.executor, bookId, key, {
        status: response.statusCode,
        responseBody: captured ?? null,
        entryId: idempotentEntryId ?? null,
        completedAt: dependencies.clock.now(),
      })
      .catch((error: unknown) => {
        // Logged, never rethrown: the response has already been sent, and an unhandled
        // rejection here would take the process down over a bookkeeping write.
        response.req.log.error({ err: error, key }, 'failed to complete idempotency reservation');
      });
  });
}

/**
 * Whether a finished reservation's answer may be handed to a retry.
 *
 * **The cache is for outcomes that are a function of the request.** Almost every 4xx here is:
 * an unbalanced entry is unbalanced whoever asks and whenever, a reused key is reused, a
 * malformed body stays malformed. Replaying those costs the caller nothing, because re-running
 * them would produce the identical answer at the price of doing the work again.
 *
 * Two kinds of answer are not a function of the request, and both are excluded.
 *
 * A 5xx says the server failed, not that the request was refused - it is not an outcome at
 * all. The row is still completed rather than left dangling, so the key does not answer 409
 * forever, and a retry re-runs and overwrites it.
 *
 * `ACCOUNT_OVERDRAWN` is the system's first *state-dependent* 4xx, and it is excluded for a
 * different reason: the same body succeeds or fails depending on the account's balance, which
 * anything else in the book can change at any moment. Caching it would pin an answer that has
 * since stopped being true - and pin it against precisely the client doing the right thing,
 * who gets a 422, deposits the shortfall the response told them about, retries under the same
 * key exactly as an idempotency key is meant to be used, and is handed the stale refusal
 * forever. The key still does what it promises here: it guarantees the withdrawal happens at
 * most once, which is the property that matters, and it is the response rather than the effect
 * that is allowed to differ between attempts.
 *
 * `EntryResource.reversedBy` is the first mutable field to sit inside a body this cache freezes:
 * a replayed `POST /entries` can report an entry as unreversed after it has, in fact, since been
 * reversed through a different request. That is the same contract as everywhere else in this
 * comment, not an oversight - retrying the same HTTP call returns the same HTTP response, and
 * whether that response happens to still describe the current state of the ledger is exactly
 * what this function does not promise.
 */
/** The one code this cache refuses to serve stale, typed so renaming it fails the build here too. */
const NOT_REPLAYABLE_CODE: DomainErrorCode = 'ACCOUNT_OVERDRAWN';

function isReplayable(status: number | null, body: unknown): status is number {
  if (status === null || status >= 500) return false;

  const { code } = (body ?? {}) as { code?: unknown };
  return code !== NOT_REPLAYABLE_CODE;
}

function replay(response: Response, status: number, body: unknown): void {
  response.setHeader(REPLAYED_HEADER, 'true');
  response.status(status).json(body);
}

function keyOf(request: Request): string | null {
  // GET and the rest are idempotent by definition; a key on one would be a promise about
  // something that needs no promise.
  if (request.method !== 'POST') return null;

  const raw = request.get(IDEMPOTENCY_HEADER);
  if (raw === undefined) return null;

  const key = raw.trim();
  if (key === '' || key.length > MAX_KEY_LENGTH) {
    throw new ValidationError(`invalid ${IDEMPOTENCY_HEADER} header`, [
      {
        path: IDEMPOTENCY_HEADER,
        message: `must be between 1 and ${String(MAX_KEY_LENGTH)} characters`,
      },
    ]);
  }

  return key;
}

/**
 * What makes two requests "the same request".
 *
 * The raw bytes the client sent, not the parsed object: hashing the parse would hash whatever
 * key order and number formatting this particular parser produced, and two clients sending
 * identical JSON with different whitespace would disagree about their own request. The method
 * and path are in there because the same key against a different endpoint is not a retry
 * either.
 */
function fingerprintOf(request: Request): string {
  const { rawBody } = request as { rawBody?: Buffer };

  return createHash('sha256')
    .update(request.method)
    .update('\n')
    .update(request.originalUrl)
    .update('\n')
    .update(rawBody ?? Buffer.alloc(0))
    .digest('hex');
}
