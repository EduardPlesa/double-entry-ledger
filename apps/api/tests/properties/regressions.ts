/**
 * Counterexamples this suite has actually found, replayed on every run.
 *
 * fast-check's `examples` option runs these before it generates anything, at negligible cost.
 * Unlike a recorded seed they state what they are defending against and survive the generators
 * being rewritten — a seed reproduces nothing once an arbitrary changes shape, which is the
 * only form in which a regression test is still a regression test in a year.
 *
 * **Empty, and honestly so.** Nothing is planted here to demonstrate the mechanism. When a
 * property finds something, transcribe the shrunk case below with a comment naming the defect,
 * and write the story into the README's property-testing section.
 *
 * **The command property is not covered here.** `ledger.property.test.ts` draws its sequence
 * through `fc.gen()`, whose inputs are a stream of generator draws rather than a value anyone
 * can write down. A counterexample from that property gets transcribed as an ordinary
 * `it()` in `tests/properties/` that replays the shrunk command sequence by hand against a
 * fresh book — which is a better regression test anyway, because it names the sequence instead
 * of encoding it.
 */

// fast-check's `examples` option types as `T[]`, not `readonly T[]` — these stay mutable to
// match, since a `readonly` array here would be rejected by `fc.assert` and a cast would hide
// a real mismatch rather than express one that doesn't exist.

/** Amounts that broke the HTTP round trip. Tuples matching `AMOUNT_MINOR` in `http.property.test.ts`. */
export const HTTP_AMOUNT_EXAMPLES: [bigint][] = [];

/** Batch shapes that broke conservation. Tuples matching the amounts array in `conservation.property.test.ts`. */
export const CONCURRENT_BATCH_EXAMPLES: [bigint[]][] = [];
