import type { LedgerCommand } from './commands.js';

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
 * **The command property is covered here too.** `ledgerCommands` (`commands.ts`) is a plain
 * arbitrary — it generates account *indices*, resolved against whichever real book a case runs
 * against inside each command's `run()`, so it no longer needs `fc.gen()` to defer generation
 * until a book exists. That means a failing sequence shrinks and replays like any other
 * property, and a shrunk counterexample can be transcribed into `LEDGER_COMMAND_EXAMPLES`
 * below as a one-tuple `[commands]`, matching the other two arrays here: build the array of
 * commands fast-check printed - each command class (`PostEntryCommand`, `ReverseEntryCommand`,
 * `ReadBalanceCommand`, `ReadPostingsCommand`, `ReadTrialBalanceCommand`, all exported from
 * `commands.ts`) takes the same constructor arguments shown in the failure output, plus a
 * `Tally` to accumulate into - a fresh all-zero one is fine, since the coverage guard in
 * `ledger.property.test.ts` only needs the *generated* cases to clear it, not the replayed
 * examples.
 */

// fast-check's `examples` option types as `T[]`, not `readonly T[]` — these stay mutable to
// match, since a `readonly` array here would be rejected by `fc.assert` and a cast would hide
// a real mismatch rather than express one that doesn't exist.

/** Amounts that broke the HTTP round trip. Tuples matching `AMOUNT_MINOR` in `http.property.test.ts`. */
export const HTTP_AMOUNT_EXAMPLES: [bigint][] = [];

/** Batch shapes that broke conservation. Tuples matching the amounts array in `conservation.property.test.ts`. */
export const CONCURRENT_BATCH_EXAMPLES: [bigint[]][] = [];

/** Command sequences that broke a ledger invariant. Each entry is one full sequence, transcribed by hand. */
export const LEDGER_COMMAND_EXAMPLES: [Iterable<LedgerCommand>][] = [];
