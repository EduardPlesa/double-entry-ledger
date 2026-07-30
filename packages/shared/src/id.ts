import { uuidv7 } from 'uuidv7';

/**
 * Identifiers are UUIDv7: a 48-bit big-endian millisecond timestamp followed by
 * randomness. Two properties matter here.
 *
 * Index locality. Rows created close together sort close together, so inserts land at
 * the right edge of the B-tree instead of scattering random pages. At the 500k-posting
 * scale this project benchmarks later, that is the difference between a warm write path
 * and one that dirties a page per insert.
 *
 * Generated in the application, not the database. Postgres 16 has no native uuidv7()
 * (that arrived in 18), but more importantly a service that can name a row before
 * inserting it can build a whole entry - postings included - in memory and hand the
 * database one atomic write, with no round-trip just to learn an id.
 *
 * The timestamp prefix is deliberately not treated as a clock. Anything that needs to
 * know when something happened reads occurred_at or recorded_at.
 */
export function newId(): string {
  return uuidv7();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
