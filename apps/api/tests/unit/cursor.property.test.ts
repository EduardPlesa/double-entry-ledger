import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InvalidCursorError } from '../../src/domain/errors.js';
import { decodePostingCursor, encodePostingCursor } from '../../src/services/cursor.js';

/**
 * The cursor is the one opaque value this API hands a client and expects back verbatim, so
 * the two claims worth stating are that it survives the trip and that nothing else does.
 *
 * The second matters more than it looks. `decodePostingCursor` reaches `BigInt(match[1])` only
 * behind a regex, and the property is what keeps that true if the regex is ever loosened: a
 * `BigInt()` on unvalidated input throws `SyntaxError`, which the HTTP layer has no mapping
 * for and would answer with a 500 rather than a 400.
 */

/** Posting ids are `bigserial`, so non-negative and bounded by int8. */
const POSTING_ID = fc.bigInt({ min: 0n, max: 2n ** 63n - 1n });

describe('posting cursors', () => {
  it('round-trips every posting id', () => {
    fc.assert(
      fc.property(POSTING_ID, (id) => {
        expect(decodePostingCursor(encodePostingCursor(id))).toBe(id);
      }),
    );
  });

  it('rejects arbitrary strings with InvalidCursorError and nothing else', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (candidate) => {
        // A generated string could in principle base64url-decode to a well-formed cursor, so
        // the property is not "always throws" - it is "throws the mapped error, or succeeds
        // with a value the encoder would have produced". Any other exception is the bug.
        let decoded: bigint;
        try {
          decoded = decodePostingCursor(candidate);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidCursorError);
          return;
        }

        expect(decoded).toBeGreaterThanOrEqual(0n);
      }),
    );
  });
});
