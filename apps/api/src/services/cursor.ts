import { InvalidCursorError } from '../domain/errors.js';

/**
 * Pagination cursors.
 *
 * A cursor is a posting id, base64url-encoded behind a version tag. The encoding buys
 * nothing cryptographically - anyone can decode it - and that is not what it is for. It is
 * for making the cursor opaque *by convention*, so that no client starts constructing one
 * by hand and pinning the ordering key in place forever. The version tag is how a later
 * stage changes what a cursor contains without silently misreading the old ones.
 */

const VERSION = 'p1';

export function encodePostingCursor(postingId: bigint): string {
  return Buffer.from(`${VERSION}:${postingId.toString()}`, 'utf8').toString('base64url');
}

export function decodePostingCursor(cursor: string): bigint {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError(cursor);
  }

  const match = /^p1:(\d+)$/.exec(decoded);
  if (match?.[1] === undefined) throw new InvalidCursorError(cursor);

  return BigInt(match[1]);
}
