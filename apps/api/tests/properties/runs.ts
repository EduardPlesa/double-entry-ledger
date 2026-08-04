/**
 * How many cases a property runs.
 *
 * Low by default, because a case here costs a book and a few dozen round trips and `pnpm test`
 * has to stay something people run while editing. CI raises it, which is where the properties
 * earn their keep.
 *
 * `process.env` is banned everywhere but `config.ts` and `drizzle.config.ts`. `eslint.config.js`
 * exempts this file by name - not the test tree - so the ban stays enforced everywhere else and
 * a second reader would have to argue for itself rather than inherit an exemption.
 */
export function propertyRuns(fallback = 25): number {
  const raw = process.env.LEDGER_PROPERTY_RUNS;
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `LEDGER_PROPERTY_RUNS must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }

  return parsed;
}
