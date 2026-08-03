# Stage 5 — Property-Based Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** State the ledger's invariants as fast-check properties over generated command sequences run against a real Postgres, and add a query-count assertion that fails when a read path's round trips grow with its result size.

**Architecture:** An in-memory `LedgerModel` is advanced alongside `LedgerService` by an `fc.commands` sequence. The model records only what the service accepted — it never predicts a refusal — so the properties are about reachable states rather than about decisions. Pure properties over `Money` and the pagination cursor run in the unit projects with no container. A pool-level statement recorder backs the N+1 assertions.

**Tech Stack:** TypeScript, Node 22, Vitest 4, fast-check 4, pg, drizzle-orm, Testcontainers Postgres 16.

**Spec:** `docs/superpowers/specs/2026-08-03-stage-5-property-tests-design.md`

## Global Constraints

- Money is `bigint` minor units. Never a JS `number` for an amount, not even in a test.
- Amounts cross the service boundary as **decimal strings**. Build them with `formatMoney` from `@ledger/shared`; never by hand.
- Entries are append-only. No test may UPDATE or DELETE `entries` or `postings`. Isolation comes from seeding a fresh book, never from cleanup.
- Every read of `accounts`, `entries` or `postings` must happen inside a transaction that has set `app.current_book_id`. Use `withBookClient` / `queryInBook` / `balanceOf` from `tests/helpers/ledger.js`, never a bare `pool.query`.
- `process.env` is banned outside `apps/api/src/config.ts` and `apps/api/drizzle.config.ts`. `eslint.config.js` already exempts `apps/api/tests/**`, so the runs knob is legal only inside `apps/api/tests/`.
- fast-check version: `4.9.0`, pinned exactly (this repo pins every dependency exactly — no `^`).
- Conventional commits. No attribution footer in commit messages.
- Run lint and typecheck before every commit: `pnpm lint` and `pnpm typecheck` from the repo root.

## Vitest projects, and which one each new file lands in

| Project | Include glob | Container? | New files |
| --- | --- | --- | --- |
| `unit` (apps/api) | `tests/unit/**/*.test.ts` | no | `tests/unit/cursor.property.test.ts` |
| `integration` | `tests/{db,services,http}/**/*.test.ts` | yes | `tests/services/query-count.test.ts` |
| `concurrency` | `tests/concurrency/**/*.test.ts` | yes | `tests/concurrency/conservation.property.test.ts` |
| `properties` (**new**) | `tests/properties/**/*.test.ts` | yes | the command harness, the HTTP property |
| `@ledger/shared` own run | `src/**/*.test.ts` | no | `src/money.property.test.ts` |

---

### Task 1: `Money` properties

Pure, no container, no database. `@ledger/shared` has its own `vitest run`, so this task is fully self-contained.

**Files:**
- Modify: `packages/shared/package.json` (add fast-check to devDependencies)
- Create: `packages/shared/src/money.property.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on. This task establishes the convention every later property file follows — `fc.assert(fc.property(...))` inside a plain Vitest `it`.

- [ ] **Step 1: Add fast-check to `@ledger/shared`**

In `packages/shared/package.json`, add to `devDependencies`, keeping the keys alphabetical:

```json
  "devDependencies": {
    "fast-check": "4.9.0",
    "typescript": "5.9.3",
    "vitest": "4.1.10"
  }
```

Then install:

```bash
pnpm install
```

- [ ] **Step 2: Write the failing property test**

Create `packages/shared/src/money.property.test.ts`:

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMoney,
  formatMoney,
  minorUnitDigits,
  money,
  negateMoney,
  parseMoney,
  sumMoney,
} from './money.js';

/**
 * `Money` as properties rather than as examples.
 *
 * Every amount in this system passes through this module, so a defect here is a defect
 * everywhere at once - and it would surface in the database properties three layers away from
 * its cause, as a disagreement nobody could read. These run in microseconds and there is no
 * reason not to run a lot of them.
 *
 * The currencies are chosen for their minor-unit digits, not their popularity: JPY has none,
 * KWD has three, EUR and USD have the two that a formatter written from one example assumes.
 */

const CURRENCY = fc.constantFrom('EUR', 'USD', 'JPY', 'KWD');

/**
 * Well past `Number.MAX_SAFE_INTEGER` in both directions. The existing `money.test.ts` pins a
 * handful of those by hand; this is the same claim over the whole range.
 */
const AMOUNT_MINOR = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });

describe('formatMoney and parseMoney', () => {
  it('round-trips every amount in every currency', () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, CURRENCY, (amountMinor, currency) => {
        const original = money(amountMinor, currency);
        const reparsed = parseMoney(formatMoney(original), currency);

        expect(reparsed.amountMinor).toBe(amountMinor);
        expect(reparsed.currency).toBe(currency);
      }),
    );
  });

  it('always emits exactly the currency’s minor-unit digits', () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, CURRENCY, (amountMinor, currency) => {
        const digits = minorUnitDigits(currency);
        const formatted = formatMoney(money(amountMinor, currency));

        if (digits === 0) {
          expect(formatted).not.toContain('.');
          return;
        }

        const fraction = formatted.split('.')[1];
        expect(fraction, `no fractional part in ${formatted}`).toBeDefined();
        expect(fraction).toHaveLength(digits);
      }),
    );
  });

  it('keeps the sign of a value that rounds to zero major units', () => {
    // -0.05 EUR formats as "-0.05" and must parse back negative. Sign handling around the
    // decimal point is where a formatter written from the positive case breaks, and it breaks
    // exactly here - where the whole part is zero and the sign lives nowhere else.
    fc.assert(
      fc.property(fc.bigInt({ min: -99n, max: -1n }), (amountMinor) => {
        const formatted = formatMoney(money(amountMinor, 'EUR'));

        expect(formatted.startsWith('-')).toBe(true);
        expect(parseMoney(formatted, 'EUR').amountMinor).toBe(amountMinor);
      }),
    );
  });
});

describe('addMoney', () => {
  it('is associative', () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, AMOUNT_MINOR, AMOUNT_MINOR, CURRENCY, (a, b, c, currency) => {
        const left = addMoney(addMoney(money(a, currency), money(b, currency)), money(c, currency));
        const right = addMoney(money(a, currency), addMoney(money(b, currency), money(c, currency)));

        expect(left.amountMinor).toBe(right.amountMinor);
      }),
    );
  });

  it('is commutative', () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, AMOUNT_MINOR, CURRENCY, (a, b, currency) => {
        expect(addMoney(money(a, currency), money(b, currency)).amountMinor).toBe(
          addMoney(money(b, currency), money(a, currency)).amountMinor,
        );
      }),
    );
  });

  it('cancels against the negation', () => {
    fc.assert(
      fc.property(AMOUNT_MINOR, CURRENCY, (amountMinor, currency) => {
        const value = money(amountMinor, currency);
        expect(addMoney(value, negateMoney(value)).amountMinor).toBe(0n);
      }),
    );
  });
});

describe('sumMoney', () => {
  it('agrees with folding addMoney', () => {
    fc.assert(
      fc.property(fc.array(AMOUNT_MINOR, { maxLength: 20 }), CURRENCY, (amounts, currency) => {
        const values = amounts.map((amount) => money(amount, currency));
        const folded = values.reduce((total, value) => addMoney(total, value), money(0n, currency));

        expect(sumMoney(values, currency).amountMinor).toBe(folded.amountMinor);
      }),
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
pnpm --filter @ledger/shared test
```

Expected: FAIL, `Cannot find module 'fast-check'` — if step 1's install did not run. If it already passes, step 1 succeeded and the properties genuinely hold; that is the expected outcome for this task, since it tests code correct since stage 2. Re-run after step 1 either way.

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @ledger/shared test
```

Expected: PASS, 7 tests.

If the round-trip property fails, do **not** relax the property — a counterexample here is a real `Money` defect and belongs in `packages/shared/src/money.test.ts` as a permanent example before anything else proceeds.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint
pnpm typecheck
git add packages/shared/package.json packages/shared/src/money.property.test.ts pnpm-lock.yaml
git commit -m "test(shared): Money as properties, over the whole bigint range"
```

---

### Task 2: Cursor properties

**Files:**
- Modify: `apps/api/package.json` (add fast-check)
- Create: `apps/api/tests/unit/cursor.property.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `fast-check` present in `apps/api`, which every later task depends on.

- [ ] **Step 1: Add fast-check to `apps/api`**

In `apps/api/package.json` `devDependencies`, keeping keys alphabetical, add between `"dotenv"` and `"drizzle-kit"`:

```json
    "fast-check": "4.9.0",
```

Then:

```bash
pnpm install
```

- [ ] **Step 2: Write the failing property test**

Create `apps/api/tests/unit/cursor.property.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to verify it fails**

```bash
pnpm --filter @ledger/api exec vitest run --project unit cursor.property
```

Expected: FAIL with `Cannot find module 'fast-check'` if step 1's install has not run. Otherwise it passes — as with Task 1, green is the expected outcome, and a red is a real defect to pin as an example test before continuing.

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @ledger/api exec vitest run --project unit cursor.property
```

Expected: PASS, 2 tests. No container starts — the `unit` project has no `globalSetup`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/package.json apps/api/tests/unit/cursor.property.test.ts pnpm-lock.yaml
git commit -m "test(http): the cursor round-trips, and nothing else decodes"
```

---

### Task 3: The query-count helper and the N+1 assertions

Independent of every property task. Lands in the `integration` project because it is an example-based test, not a property.

**Files:**
- Create: `apps/api/tests/helpers/query-count.ts`
- Create: `apps/api/tests/services/query-count.test.ts`

**Interfaces:**
- Consumes: `createService` from `tests/helpers/service.js`, `seedBookIn` from `tests/helpers/ledger.js`.
- Produces:
  ```ts
  export interface Measurement<T> { readonly result: T; readonly statements: readonly string[] }
  export interface QueryRecorder { measure<T>(fn: () => Promise<T>): Promise<Measurement<T>> }
  export function instrumentPool(pool: Pool): QueryRecorder
  ```
  No later task consumes these.

- [ ] **Step 1: Write the helper**

Create `apps/api/tests/helpers/query-count.ts`:

```ts
import type { Pool, PoolClient } from 'pg';

/**
 * Counts the statements a block of work actually sends.
 *
 * At the driver, not at the ORM. `BEGIN`, `set_config` and `COMMIT` are statements the process
 * sent and round trips it paid for, and the number an N+1 assertion is about is round trips.
 * Counting what drizzle chose to report through its `logger` option would miss a raw
 * `pool.query`, which is precisely the shape an extra round trip takes when one gets added.
 *
 * `pool.query` acquires a client and calls `client.query` on it, so patching clients catches
 * pooled and transactional statements alike with one hook.
 *
 * **Instrument the pool before anything queries it.** The `connect` event only fires for
 * connections opened after the listener is attached; a client already idle in the pool would
 * go unpatched and its statements would be invisible. Callers create their own pool and
 * instrument it in the same breath.
 */

export interface Measurement<T> {
  readonly result: T;
  /** In the order they were sent, whitespace collapsed, truncated for readability. */
  readonly statements: readonly string[];
}

export interface QueryRecorder {
  measure<T>(fn: () => Promise<T>): Promise<Measurement<T>>;
}

/** Marks a client as already wrapped, so a reconnect cannot stack two wrappers on one client. */
const PATCHED = Symbol('ledger.queryCountPatched');

interface PatchableClient {
  query: (...args: unknown[]) => unknown;
  [PATCHED]?: true;
}

export function instrumentPool(pool: Pool): QueryRecorder {
  let recording: string[] | null = null;

  const patch = (client: PoolClient): void => {
    const patchable = client as unknown as PatchableClient;
    if (patchable[PATCHED] === true) return;
    patchable[PATCHED] = true;

    const original = patchable.query.bind(patchable);
    patchable.query = (...args: unknown[]): unknown => {
      recording?.push(statementText(args[0]));
      return original(...args);
    };
  };

  pool.on('connect', patch);

  return {
    async measure<T>(fn: () => Promise<T>): Promise<Measurement<T>> {
      if (recording !== null) {
        throw new Error('measure() is already recording: nested measurements are not supported');
      }

      const statements: string[] = [];
      recording = statements;

      try {
        return { result: await fn(), statements };
      } finally {
        recording = null;
      }
    },
  };
}

/** The first argument to `client.query` is either the SQL or a config object carrying it. */
function statementText(first: unknown): string {
  const raw = typeof first === 'string' ? first : textOf(first);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function textOf(candidate: unknown): string {
  if (typeof candidate === 'object' && candidate !== null && 'text' in candidate) {
    const { text } = candidate as { text: unknown };
    if (typeof text === 'string') return text;
  }
  return '<unrecognised statement>';
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/tests/services/query-count.test.ts`:

```ts
import { formatMoney, money } from '@ledger/shared';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { seedBookIn, type Book } from '../helpers/ledger.js';
import { instrumentPool, type QueryRecorder } from '../helpers/query-count.js';
import { createService } from '../helpers/service.js';

/**
 * The N+1 guard.
 *
 * A read path whose round trips grow with the size of its result is the regression this file
 * exists to fail on, and it is invisible to every other test in the suite: an N+1 returns
 * exactly the right answer, just once per row. So the assertion is not about correctness at
 * all - it is that the *same work* is done for one row as for fifty.
 *
 * Invariance is the guard; the exact count beside it catches creep, where each new round trip
 * looks reasonable on its own and nobody is counting.
 */

/** Enough postings on one account that a page of 50 and a page of 1 are genuinely different. */
const POSTINGS = 60;

let pool: Pool;
let recorder: QueryRecorder;
let service: LedgerService;
let book: Book;

beforeAll(async () => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 5 });
  // Before the first query, or the clients already in the pool go unpatched.
  recorder = instrumentPool(pool);
  service = createService(pool).service;

  book = await seedBookIn(pool);

  for (let index = 0; index < POSTINGS; index += 1) {
    await service.postEntry(book.bookId, {
      occurredAt: '2026-01-01T00:00:00.000Z',
      description: `seed ${index.toString()}`,
      legs: [
        { accountId: book.cash, amount: formatMoney(money(100n, 'EUR')), currency: 'EUR' },
        { accountId: book.sales, amount: formatMoney(money(-100n, 'EUR')), currency: 'EUR' },
      ],
    });
  }
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('listPostings', () => {
  it('sends the same statements for a page of 1 as for a page of 50', async () => {
    const small = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 1 }),
    );
    const large = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 50 }),
    );

    expect(small.result.items).toHaveLength(1);
    expect(large.result.items).toHaveLength(50);

    expect(
      large.statements.length,
      `page of 50 sent:\n${large.statements.join('\n')}\n\npage of 1 sent:\n${small.statements.join('\n')}`,
    ).toBe(small.statements.length);
  });

  it('sends a fixed number of statements on the first page', async () => {
    const page = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 10 }),
    );

    // begin, set_config, find the account, read the page, commit. No opening-balance sum,
    // because the first page opens at zero.
    expect(page.statements, page.statements.join('\n')).toHaveLength(5);
  });

  it('sends one more statement on a later page, for the opening balance', async () => {
    const first = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { limit: 10 }),
    );
    const cursor = first.result.nextCursor;
    expect(cursor).not.toBeNull();

    const second = await recorder.measure(() =>
      service.listPostings(book.bookId, book.cash, { cursor: cursor ?? undefined, limit: 10 }),
    );

    // The extra one is `sumPostingsThrough`: a fresh sum-from-zero up to the cursor, which is
    // the query stage 7 replaces with a checkpoint lookup. Pinned so that replacement is a
    // deliberate edit to this number rather than a silent change.
    expect(second.statements, second.statements.join('\n')).toHaveLength(6);
  });
});

describe('trialBalance', () => {
  it('sends the same statements however many accounts the book has', async () => {
    const small = await recorder.measure(() => service.trialBalance(book.bookId));

    const wide = await seedBookIn(pool);
    for (let index = 0; index < 14; index += 1) {
      await service.createAccount(wide.bookId, {
        name: `Extra ${index.toString()}`,
        type: 'expense',
        currency: 'EUR',
      });
    }

    const large = await recorder.measure(() => service.trialBalance(wide.bookId));

    expect(small.result.accounts.length).toBeLessThan(large.result.accounts.length);
    expect(
      large.statements.length,
      `wide book sent:\n${large.statements.join('\n')}`,
    ).toBe(small.statements.length);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
pnpm --filter @ledger/api exec vitest run --project integration query-count
```

Expected: FAIL — `Cannot find module '../helpers/query-count.js'` if step 1 was skipped, otherwise the two exact-count assertions may report a different number than 5 and 6.

**If the counts differ:** the failure message prints every statement that ran. Read them, confirm each one is a round trip the service genuinely needs, and correct the constants **and their comments** to match. The point of these two assertions is that the number is pinned and explained, not that this plan's arithmetic was right. If a statement in the list looks unnecessary, that is a finding — report it rather than encoding it.

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @ledger/api exec vitest run --project integration query-count
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/tests/helpers/query-count.ts apps/api/tests/services/query-count.test.ts
git commit -m "test(ledger): pin the read paths' round trips, so an N+1 fails CI"
```

---

### Task 4: The `properties` project, the model, and the generators

Produces a first, deliberately simple property so the scaffolding is exercised before the command harness lands on top of it.

**Files:**
- Modify: `apps/api/vitest.config.ts`
- Create: `apps/api/tests/properties/runs.ts`
- Create: `apps/api/tests/properties/model.ts`
- Create: `apps/api/tests/properties/arbitraries.ts`
- Create: `apps/api/tests/properties/fixture.ts`
- Create: `apps/api/tests/properties/ledger.property.test.ts`

**Interfaces:**
- Consumes: `createService` (`tests/helpers/service.js`), `seedBookIn` and `Book` (`tests/helpers/ledger.js`), `AccountRecord` (`src/repositories/ledger.repository.js`), `isGuardedAccountType` (`src/domain/overdraft.js`).
- Produces, relied on by Tasks 5–9:
  ```ts
  // runs.ts
  export function propertyRuns(fallback?: number): number

  // model.ts
  export interface ModelPosting { accountId: string; amountMinor: bigint; occurredAt: Date; seq: number }
  export interface ModelEntry { id: string; occurredAt: Date; legs: readonly ModelLeg[]; reversedBy: string | null }
  export interface ModelLeg { accountId: string; amountMinor: bigint }
  export class LedgerModel {
    constructor(accounts: readonly AccountRecord[]);
    readonly accounts: readonly AccountRecord[];
    accountById(accountId: string): AccountRecord | undefined;
    record(entry: { id: string; occurredAt: Date; legs: readonly ModelLeg[] }): void;
    markReversed(originalId: string, reversalId: string): void;
    balanceOf(accountId: string): bigint;
    totalsByCurrency(): Map<string, bigint>;
    postingsOf(accountId: string): readonly ModelPosting[];
    lowestPrefix(accountId: string): { balanceMinor: bigint; occurredAt: Date } | null;
    reversibleEntries(): readonly ModelEntry[];
    entryCount(): number;
  }

  // arbitraries.ts
  export interface LegSpec { accountId: string; amountMinor: bigint; currency: string }
  export interface EntrySpec { occurredAt: string; description: string; legs: readonly LegSpec[] }
  export function entrySpec(accounts: readonly AccountRecord[]): fc.Arbitrary<EntrySpec>
  export function toPostEntryInput(spec: EntrySpec): PostEntryInput
  export function hasNegativeGuardedLeg(spec: EntrySpec, model: LedgerModel): boolean

  // fixture.ts
  export interface PropertyBook { bookId: string; accounts: readonly AccountRecord[]; service: LedgerService }
  export function createPropertyBook(pool: Pool): Promise<PropertyBook>
  ```

- [ ] **Step 1: Add the `properties` project to the vitest config**

In `apps/api/vitest.config.ts`, add a fourth entry to `projects`, after the `concurrency` one:

```ts
      {
        test: {
          name: 'properties',
          include: ['tests/properties/**/*.test.ts'],
          globalSetup: ['./tests/setup/postgres.global.ts'],

          // A single case is a book seed plus a few dozen round trips, and a run is dozens of
          // cases. This is the real number, not padding.
          testTimeout: 180_000,
          hookTimeout: 120_000,

          // Same discipline as `integration`: one book per case is what isolates these, and a
          // single worker keeps failures readable and connection counts sane.
          pool: 'threads',
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
```

Also extend the file's leading comment: change `Three projects, because three kinds of test.` to `Four projects, because four kinds of test.` and add a paragraph after the `concurrency` explanation:

```
 * `properties` needs the same container as `integration` and the same single-worker
 * discipline, but not its budget: a property run is tens of seconds where an integration file
 * is a second. Folding it in would make every run of the suite people execute while editing
 * pay for it, and the pressure would then be to shrink `numRuns` until the properties stopped
 * being properties.
```

- [ ] **Step 2: Write the runs knob**

Create `apps/api/tests/properties/runs.ts`:

```ts
/**
 * How many cases a property runs.
 *
 * Low by default, because a case here costs a book and a few dozen round trips and `pnpm test`
 * has to stay something people run while editing. CI raises it, which is where the properties
 * earn their keep.
 *
 * `process.env` is banned everywhere but `config.ts`; `eslint.config.js` exempts
 * `apps/api/tests/**`, and this is the only place in the test tree that uses the exemption.
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
```

- [ ] **Step 3: Write the model**

Create `apps/api/tests/properties/model.ts`:

```ts
import type { AccountRecord } from '../../src/repositories/ledger.repository.js';

/**
 * What the ledger holds, according to everything the service accepted.
 *
 * The model **follows**. It records the outcome of a call that succeeded and records nothing
 * for one that was refused, and it contains no reimplementation of the overdraft rule. The
 * properties are therefore about the states the system can reach, not about the decisions it
 * makes getting there - which is what keeps the rule from existing a third time, after the SQL
 * in migration 0007 and the check in the service.
 *
 * No balance is stored as a mutable number. Balances are summed from `postings` when asked,
 * which is invariant 4 of this project applied to the test double as well as to the system.
 */

export interface ModelLeg {
  readonly accountId: string;
  readonly amountMinor: bigint;
}

export interface ModelPosting {
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly occurredAt: Date;
  /** Stands in for `postings.id`: monotone, and the prefix rule's tiebreaker. */
  readonly seq: number;
}

export interface ModelEntry {
  readonly id: string;
  readonly occurredAt: Date;
  readonly legs: readonly ModelLeg[];
  reversedBy: string | null;
}

export class LedgerModel {
  readonly accounts: readonly AccountRecord[];

  private readonly byId: ReadonlyMap<string, AccountRecord>;
  private readonly postings: ModelPosting[] = [];
  private readonly entries: ModelEntry[] = [];
  private nextSeq = 0;

  constructor(accounts: readonly AccountRecord[]) {
    this.accounts = accounts;
    this.byId = new Map(accounts.map((account) => [account.id, account]));
  }

  accountById(accountId: string): AccountRecord | undefined {
    return this.byId.get(accountId);
  }

  /** Records an entry the service accepted. Legs take consecutive `seq` values, as ids do. */
  record(entry: { id: string; occurredAt: Date; legs: readonly ModelLeg[] }): void {
    this.entries.push({
      id: entry.id,
      occurredAt: entry.occurredAt,
      legs: [...entry.legs],
      reversedBy: null,
    });

    for (const leg of entry.legs) {
      this.nextSeq += 1;
      this.postings.push({
        accountId: leg.accountId,
        amountMinor: leg.amountMinor,
        occurredAt: entry.occurredAt,
        seq: this.nextSeq,
      });
    }
  }

  markReversed(originalId: string, reversalId: string): void {
    const original = this.entries.find((entry) => entry.id === originalId);
    if (original === undefined) {
      throw new Error(`the model has no entry ${originalId} to mark reversed`);
    }
    original.reversedBy = reversalId;
  }

  balanceOf(accountId: string): bigint {
    let total = 0n;
    for (const posting of this.postings) {
      if (posting.accountId === accountId) total += posting.amountMinor;
    }
    return total;
  }

  /** The book's total per currency. Zero in every currency, or the ledger is broken. */
  totalsByCurrency(): Map<string, bigint> {
    const totals = new Map<string, bigint>();

    for (const posting of this.postings) {
      const account = this.byId.get(posting.accountId);
      if (account === undefined) continue;
      totals.set(account.currency, (totals.get(account.currency) ?? 0n) + posting.amountMinor);
    }

    return totals;
  }

  /** An account's postings in `(occurredAt, seq)` order - the order the prefix rule reads them in. */
  postingsOf(accountId: string): readonly ModelPosting[] {
    return this.postings
      .filter((posting) => posting.accountId === accountId)
      .sort((left, right) => {
        const byTime = left.occurredAt.getTime() - right.occurredAt.getTime();
        return byTime !== 0 ? byTime : left.seq - right.seq;
      });
  }

  /**
   * The lowest running balance the account ever reaches, and when.
   *
   * The same answer `lowestPrefixBalance` computes with a window function, arrived at by an
   * array scan instead. Ties on the running total are broken by `occurredAt` ascending,
   * matching that query's `order by running asc, occurred_at asc`.
   */
  lowestPrefix(accountId: string): { balanceMinor: bigint; occurredAt: Date } | null {
    const ordered = this.postingsOf(accountId);
    if (ordered.length === 0) return null;

    let running = 0n;
    let lowest: { balanceMinor: bigint; occurredAt: Date } | null = null;

    for (const posting of ordered) {
      running += posting.amountMinor;

      const better =
        lowest === null ||
        running < lowest.balanceMinor ||
        (running === lowest.balanceMinor && posting.occurredAt < lowest.occurredAt);

      if (better) lowest = { balanceMinor: running, occurredAt: posting.occurredAt };
    }

    return lowest;
  }

  /** Entries that have not been reversed. An entry may be reversed at most once. */
  reversibleEntries(): readonly ModelEntry[] {
    return this.entries.filter((entry) => entry.reversedBy === null);
  }

  entryCount(): number {
    return this.entries.length;
  }
}
```

- [ ] **Step 4: Write the generators**

Create `apps/api/tests/properties/arbitraries.ts`:

```ts
import { formatMoney, money } from '@ledger/shared';
import fc from 'fast-check';
import { isGuardedAccountType } from '../../src/domain/overdraft.js';
import type { AccountRecord } from '../../src/repositories/ledger.repository.js';
import type { PostEntryInput } from '../../src/services/ledger.service.js';
import type { LedgerModel } from './model.js';

/**
 * Entries a generator can produce that the service should never refuse on grounds of shape.
 *
 * Every leg names a real account in the book, carries that account's own currency, is non-zero,
 * and each currency group sums to zero on its own. Anything the service rejects from this
 * generator other than an overdraft is therefore a finding, not a badly-formed entry - which is
 * what lets the command harness fail loudly on every other error.
 */

/**
 * A small fixed set, deliberately.
 *
 * Backdating then happens constantly rather than occasionally, and two postings landing at the
 * same `occurredAt` is the common case rather than the rare one - which is what the prefix
 * rule's `(occurred_at, id)` tiebreaker needs in order to be tested at all. All three are after
 * the opening entry in `fixture.ts`, so an account is funded before anything draws on it.
 */
export const OCCURRED_AT_CHOICES = [
  '2026-01-15T00:00:00.000Z',
  '2026-02-15T00:00:00.000Z',
  '2026-03-15T00:00:00.000Z',
] as const;

/**
 * Up to €200.00 a leg, against an opening balance of €1,000.00.
 *
 * Chosen so refusals happen because the generator aimed at them: a handful of entries can spend
 * the account down, and the sequences that overdraw it are common enough to exercise the rule
 * without being so common that nothing else gets tested.
 */
const MAX_LEG_MINOR = 20_000n;

export interface LegSpec {
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface EntrySpec {
  readonly occurredAt: string;
  readonly description: string;
  readonly legs: readonly LegSpec[];
}

/** An entry, in one currency or in two, always balanced within each. */
export function entrySpec(accounts: readonly AccountRecord[]): fc.Arbitrary<EntrySpec> {
  const currencies = [...new Set(accounts.map((account) => account.currency))].sort();

  const groups = currencies.map((currency) =>
    balancedGroup(accounts.filter((account) => account.currency === currency)),
  );

  return fc
    .record({
      occurredAt: fc.constantFrom(...OCCURRED_AT_CHOICES),
      description: fc.constantFrom('generated entry', 'transfer', 'adjustment'),
      // At least one currency group; sometimes more, which is the per-currency zero-sum
      // invariant under generated load rather than in a hand-written case.
      chosen: fc.uniqueArray(fc.integer({ min: 0, max: groups.length - 1 }), {
        minLength: 1,
        maxLength: groups.length,
      }),
    })
    .chain(({ occurredAt, description, chosen }) =>
      fc
        .tuple(...chosen.map((index) => groups[index] as fc.Arbitrary<LegSpec[]>))
        .map((legGroups) => ({ occurredAt, description, legs: legGroups.flat() })),
    );
}

/**
 * Two to four accounts of one currency, with amounts summing to zero and no zero leg.
 *
 * The last leg is the negation of the others, which is how a balanced entry gets generated
 * without a filter that rejects almost everything. A zero on any of the leading legs is nudged
 * to 1 rather than filtered out, because `postEntry` refuses a zero leg and a filter here would
 * throw away most of the sample.
 */
function balancedGroup(inCurrency: readonly AccountRecord[]): fc.Arbitrary<LegSpec[]> {
  const currency = inCurrency[0]?.currency ?? 'EUR';
  const ids = inCurrency.map((account) => account.id);

  return fc
    .uniqueArray(fc.constantFrom(...ids), {
      minLength: 2,
      maxLength: Math.min(4, ids.length),
    })
    .chain((chosenIds) =>
      fc
        .array(fc.bigInt({ min: -MAX_LEG_MINOR, max: MAX_LEG_MINOR }), {
          minLength: chosenIds.length - 1,
          maxLength: chosenIds.length - 1,
        })
        .map((heads) => {
          const leading = heads.map((amount) => (amount === 0n ? 1n : amount));
          const last = -leading.reduce((total, amount) => total + amount, 0n);

          return { chosenIds, amounts: [...leading, last] };
        }),
    )
    // Only the closing leg can still be zero: it is zero exactly when the leading legs already
    // cancel. Rare, and cheaper to discard than to reshape.
    .filter(({ amounts }) => amounts.every((amount) => amount !== 0n))
    .map(({ chosenIds, amounts }) =>
      chosenIds.map((accountId, index) => ({
        accountId,
        amountMinor: amounts[index] as bigint,
        currency,
      })),
    );
}

/** The spec as the service's input: amounts as decimal strings, never as numbers. */
export function toPostEntryInput(spec: EntrySpec): PostEntryInput {
  return {
    occurredAt: spec.occurredAt,
    description: spec.description,
    legs: spec.legs.map((leg) => ({
      accountId: leg.accountId,
      amount: formatMoney(money(leg.amountMinor, leg.currency)),
      currency: leg.currency,
    })),
  };
}

/**
 * Whether this entry could possibly lower a guarded account's balance.
 *
 * An entry with no negative leg on a guarded account cannot: all its legs share one
 * `occurred_at`, its postings take ids above every existing row, so prefixes before its position
 * are untouched and every prefix at or after it rises. Such an entry is provably acceptable, and
 * that is what invariant 6 asserts.
 */
export function hasNegativeGuardedLeg(spec: EntrySpec, model: LedgerModel): boolean {
  return spec.legs.some((leg) => {
    const account = model.accountById(leg.accountId);
    return account !== undefined && isGuardedAccountType(account.type) && leg.amountMinor < 0n;
  });
}
```

- [ ] **Step 5: Write the fixture**

Create `apps/api/tests/properties/fixture.ts`:

```ts
import { formatMoney, money } from '@ledger/shared';
import type { Pool } from 'pg';
import { isGuardedAccountType } from '../../src/domain/overdraft.js';
import type { AccountRecord } from '../../src/repositories/ledger.repository.js';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { seedBookIn, type Book } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * A funded book, one per generated case.
 *
 * Funded because an empty book exercises one branch of the overdraft rule and nothing else:
 * every withdrawal from a zero balance is refused, the coverage guard fires, and the sequence
 * proves nothing. Every guarded account opens with €1,000.00 - or its currency's equivalent -
 * dated before any generated entry, so history is well-founded before anything draws on it.
 *
 * A fresh book per case rather than a shared one, because this database has no teardown by
 * design: entries and postings cannot be deleted. Isolation is disjointness.
 */

export const OPENING_MINOR = 100_000n;
export const OPENING_AT = '2026-01-01T00:00:00.000Z';

export interface PropertyBook {
  readonly bookId: string;
  readonly accounts: readonly AccountRecord[];
  readonly service: LedgerService;
}

export async function createPropertyBook(pool: Pool): Promise<PropertyBook> {
  const { service } = createService(pool);
  const book = await seedBookIn(pool);
  const records = accountsOf(book);

  // One opening entry per currency: every guarded account in it funded, the counterpart on an
  // unguarded account of the same currency so the entry balances without going short.
  const currencies = [...new Set(records.map((account) => account.currency))].sort();

  for (const currency of currencies) {
    const inCurrency = records.filter((account) => account.currency === currency);
    const guarded = inCurrency.filter((account) => isGuardedAccountType(account.type));
    const counterpart = inCurrency.find((account) => !isGuardedAccountType(account.type));

    if (guarded.length === 0 || counterpart === undefined) continue;

    await service.postEntry(book.bookId, {
      occurredAt: OPENING_AT,
      description: `opening balance ${currency}`,
      legs: [
        ...guarded.map((account) => ({
          accountId: account.id,
          amount: formatMoney(money(OPENING_MINOR, currency)),
          currency,
        })),
        {
          accountId: counterpart.id,
          amount: formatMoney(money(-OPENING_MINOR * BigInt(guarded.length), currency)),
          currency,
        },
      ],
    });
  }

  return { bookId: book.bookId, accounts: records, service };
}

/**
 * The fixture's accounts as records, without a round trip to read back what we just wrote.
 *
 * `seedBook` creates exactly these six and nothing closes them, so the shape is known. A query
 * here would be a query against `accounts` needing its own book-scoped transaction, to learn
 * what the helper that created them already knows.
 */
function accountsOf(book: Book): AccountRecord[] {
  const record = (
    id: string,
    name: string,
    type: AccountRecord['type'],
    currency: string,
  ): AccountRecord => ({ id, bookId: book.bookId, name, type, currency, closedAt: null });

  return [
    record(book.cash, 'Cash', 'asset', 'EUR'),
    record(book.bank, 'Bank', 'asset', 'EUR'),
    record(book.sales, 'Sales', 'revenue', 'EUR'),
    record(book.rent, 'Rent', 'expense', 'EUR'),
    record(book.cashUsd, 'Cash USD', 'asset', 'USD'),
    record(book.salesUsd, 'Sales USD', 'revenue', 'USD'),
  ];
}
```

- [ ] **Step 6: Write the first property**

Create `apps/api/tests/properties/ledger.property.test.ts`:

```ts
import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import { entrySpec, toPostEntryInput } from './arbitraries.js';
import { createPropertyBook } from './fixture.js';
import { LedgerModel } from './model.js';
import { propertyRuns } from './runs.js';

/**
 * The ledger's invariants over generated sequences.
 *
 * Against the real database, because the invariants this project is about are enforced half in
 * TypeScript and half in migrations 0003 and 0007. A property run against a reimplementation
 * would prove the reimplementation correct.
 */

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 10 });
});

afterAll(async () => {
  await pool.end();
});

describe('a sequence of accepted entries', () => {
  it('leaves the book summing to zero in every currency, and every balance equal to its postings', async () => {
    await fc.assert(
      // `fc.gen()` rather than an arbitrary in the signature, because the generator needs the
      // book's account ids and the book does not exist until the case starts. Values drawn
      // through `gen` still shrink.
      fc.asyncProperty(fc.gen(), async (gen) => {
        const book = await createPropertyBook(pool);
        const model = new LedgerModel(book.accounts);

        const count = gen(fc.integer, { min: 1, max: 6 });
        const specs = Array.from({ length: count }, () => gen(entrySpec, book.accounts));

        for (const spec of specs) {
          try {
            const { entry } = await book.service.postEntry(book.bookId, toPostEntryInput(spec));
            model.record({
              id: entry.id,
              occurredAt: entry.occurredAt,
              legs: entry.postings.map((posting) => ({
                accountId: posting.accountId,
                amountMinor: posting.amountMinor,
              })),
            });
          } catch (error) {
            // The only refusal this generator can legitimately provoke.
            if (!(error instanceof AccountOverdrawnError)) throw error;
          }
        }

        const report = await book.service.trialBalance(book.bookId);
        expect(report.balanced).toBe(true);

        for (const [currency, total] of model.totalsByCurrency()) {
          expect(total, `the model's ${currency} total`).toBe(0n);
        }

        for (const account of book.accounts) {
          const actual = await book.service.getBalance(book.bookId, account.id);
          expect(actual.balance.amountMinor, `balance of ${account.name}`).toBe(
            model.balanceOf(account.id),
          );
        }
      }),
      { numRuns: propertyRuns(10) },
    );
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
pnpm --filter @ledger/api exec vitest run --project properties
```

Expected: FAIL if any module is missing. Once every file above exists it should PASS. A failure of the *assertions* is a genuine finding — record the counterexample before changing anything.

- [ ] **Step 8: Run it to verify it passes**

```bash
pnpm --filter @ledger/api exec vitest run --project properties
```

Expected: PASS, 1 test. Takes roughly 30–60 seconds — the container starts once and each case seeds a book.

- [ ] **Step 9: Lint, typecheck, commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/vitest.config.ts apps/api/tests/properties
git commit -m "test(ledger): a properties project, a model that follows, and generated entries"
```

---

### Task 5: The command harness

Replaces Task 4's flat loop with `fc.commands`, adds the read commands and the coverage guard.

**Files:**
- Create: `apps/api/tests/properties/commands.ts`
- Modify: `apps/api/tests/properties/ledger.property.test.ts` (replace the flat property)

**Interfaces:**
- Consumes: everything Task 4 produced.
- Produces, relied on by Tasks 6–8:
  ```ts
  export interface Real { readonly bookId: string; readonly service: LedgerService }
  export interface Tally { accepted: number; refused: number }
  export type LedgerCommand = fc.AsyncCommand<LedgerModel, Real>
  export function assertInvariants(model: LedgerModel, real: Real): Promise<void>
  export function ledgerCommands(accounts: readonly AccountRecord[], tally: Tally): fc.Arbitrary<Iterable<LedgerCommand>>
  ```

- [ ] **Step 1: Write the commands module**

Create `apps/api/tests/properties/commands.ts`:

```ts
import fc from 'fast-check';
import { expect } from 'vitest';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import type { AccountRecord } from '../../src/repositories/ledger.repository.js';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { entrySpec, toPostEntryInput, type EntrySpec } from './arbitraries.js';
import { LedgerModel } from './model.js';

/**
 * The commands a generated sequence is made of, and the invariants checked after each.
 *
 * Reversal is why this is a command sequence rather than a list of entries: it needs an entry
 * that exists and has not already been reversed, which a flat array either cannot express or
 * expresses with indices that shrinking mangles. Commands also shrink to a minimal *sequence*,
 * which is the artifact worth promoting into a regression test.
 */

export interface Real {
  readonly bookId: string;
  readonly service: LedgerService;
}

/** Accept/refuse counts across a whole run. See `coverage` in the property file. */
export interface Tally {
  accepted: number;
  refused: number;
}

export type LedgerCommand = fc.AsyncCommand<LedgerModel, Real>;

/**
 * Checked after every command, not only after reads.
 *
 * Invariant 2 - a balance equals the sum of that account's own postings - is the load-bearing
 * one: it ties the model to the database, and every other assertion made against the model is
 * an assertion about real data only because it holds.
 */
export async function assertInvariants(model: LedgerModel, real: Real): Promise<void> {
  // 1. The book sums to zero in every currency.
  for (const [currency, total] of model.totalsByCurrency()) {
    expect(total, `the model's ${currency} total`).toBe(0n);
  }

  // 2. Every balance is the sum of that account's postings.
  for (const account of model.accounts) {
    const actual = await real.service.getBalance(real.bookId, account.id);
    expect(actual.balance.amountMinor, `balance of ${account.name}`).toBe(
      model.balanceOf(account.id),
    );
  }

  // 3. The trial balance agrees, account by account, and states that it balances.
  const report = await real.service.trialBalance(real.bookId);
  expect(report.balanced, 'the trial balance does not balance').toBe(true);

  for (const line of report.accounts) {
    expect(line.balance.amountMinor, `trial balance line for ${line.name}`).toBe(
      model.balanceOf(line.accountId),
    );
  }

  for (const total of report.totals) {
    expect(total.debits.amountMinor, `${total.currency} debits against credits`).toBe(
      total.credits.amountMinor,
    );
  }
}

class PostEntryCommand implements LedgerCommand {
  constructor(
    private readonly spec: EntrySpec,
    private readonly tally: Tally,
  ) {}

  check(): boolean {
    return true;
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    try {
      const { entry } = await real.service.postEntry(real.bookId, toPostEntryInput(this.spec));

      model.record({
        id: entry.id,
        occurredAt: entry.occurredAt,
        legs: entry.postings.map((posting) => ({
          accountId: posting.accountId,
          amountMinor: posting.amountMinor,
        })),
      });

      this.tally.accepted += 1;
    } catch (error) {
      // The generator emits only well-formed entries naming real accounts with matching
      // currencies and no zero leg, so an overdraft is the one refusal it can provoke. Anything
      // else - a validation error, a currency mismatch, an unmapped 500 - is a finding, and
      // swallowing it as "the rule refused" is how a property test quietly stops testing.
      if (!(error instanceof AccountOverdrawnError)) throw error;
      this.tally.refused += 1;
    }

    await assertInvariants(model, real);
  }

  toString(): string {
    const legs = this.spec.legs
      .map((leg) => `${leg.accountId.slice(0, 8)}:${leg.amountMinor.toString()}`)
      .join(' ');
    return `PostEntry(${this.spec.occurredAt} ${legs})`;
  }
}

class ReadBalanceCommand implements LedgerCommand {
  constructor(private readonly index: number) {}

  check(model: LedgerModel): boolean {
    return model.accounts.length > 0;
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    const account = model.accounts[this.index % model.accounts.length];
    if (account === undefined) return;

    const actual = await real.service.getBalance(real.bookId, account.id);
    expect(actual.balance.amountMinor, `balance of ${account.name}`).toBe(
      model.balanceOf(account.id),
    );

    await assertInvariants(model, real);
  }

  toString(): string {
    return `ReadBalance(#${this.index.toString()})`;
  }
}

class ReadTrialBalanceCommand implements LedgerCommand {
  check(): boolean {
    return true;
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    await assertInvariants(model, real);
  }

  toString(): string {
    return 'ReadTrialBalance()';
  }
}

export function ledgerCommands(
  accounts: readonly AccountRecord[],
  tally: Tally,
): fc.Arbitrary<Iterable<LedgerCommand>> {
  // `check` is synchronous on every command here, so the default third type argument stands.
  return fc.commands<LedgerModel, Real>(
    [
      // Weighted towards writes: a sequence of reads against an empty book asserts very little,
      // and the interesting states are the ones several entries deep.
      entrySpec(accounts).map((spec): LedgerCommand => new PostEntryCommand(spec, tally)),
      entrySpec(accounts).map((spec): LedgerCommand => new PostEntryCommand(spec, tally)),
      fc.nat().map((index): LedgerCommand => new ReadBalanceCommand(index)),
      fc.constant(new ReadTrialBalanceCommand()),
    ],
    { maxCommands: 12 },
  );
}
```

- [ ] **Step 2: Replace the property with the command run**

Overwrite `apps/api/tests/properties/ledger.property.test.ts`:

```ts
import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ledgerCommands, type Real, type Tally } from './commands.js';
import { createPropertyBook } from './fixture.js';
import { LedgerModel } from './model.js';
import { propertyRuns } from './runs.js';

/**
 * The ledger's invariants over generated command sequences.
 *
 * Against the real database, because the invariants this project is about are enforced half in
 * TypeScript and half in migrations 0003 and 0007. A property run against a reimplementation
 * would prove the reimplementation correct and say nothing about the triggers, the deferred
 * constraint or the prefix rule's window function.
 */

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 10 });
});

afterAll(async () => {
  await pool.end();
});

describe('arbitrary sequences of valid entries', () => {
  it('hold every invariant after every command', async () => {
    // Accumulated across the whole run rather than per case, and asserted afterwards. Because
    // the model never predicts a refusal, a service that refused *everything* would satisfy
    // every state invariant above - vacuous truth is the standing failure mode of property
    // testing, and this is the guard against it. It also catches a generator that has drifted
    // into producing entries nothing will accept, which is the same failure and likelier.
    const tally: Tally = { accepted: 0, refused: 0 };

    await fc.assert(
      fc.asyncProperty(fc.gen(), async (gen) => {
        const book = await createPropertyBook(pool);
        const real: Real = { bookId: book.bookId, service: book.service };

        const commands = gen(ledgerCommands, book.accounts, tally);

        await fc.asyncModelRun(() => ({ model: new LedgerModel(book.accounts), real }), commands);
      }),
      { numRuns: propertyRuns() },
    );

    expect(tally.accepted, 'no entry was ever accepted').toBeGreaterThan(0);
    expect(tally.refused, 'no entry was ever refused: the overdraft rule went untested').toBeGreaterThan(0);
    expect(
      tally.accepted,
      `only ${tally.accepted.toString()} of ${(tally.accepted + tally.refused).toString()} entries were accepted`,
    ).toBeGreaterThan(tally.refused);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
pnpm --filter @ledger/api exec vitest run --project properties
```

Expected: FAIL — `Cannot find module './commands.js'` before step 1, and after it, possibly a coverage assertion if the generated amounts turn out to overdraw more often than expected.

**If the coverage guard fails because refusals dominate**, lower `MAX_LEG_MINOR` in `arbitraries.ts` or raise `OPENING_MINOR` in `fixture.ts` until acceptances are the clear majority — and say in a comment which way you moved it and why. Do not relax the assertion.

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @ledger/api exec vitest run --project properties
```

Expected: PASS, 1 test. Roughly 60–120 seconds at `numRuns` 25.

- [ ] **Step 5: Commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/tests/properties
git commit -m "test(ledger): the invariants as a command sequence, with a coverage guard"
```

---

### Task 6: The prefix invariant and the liveness claim

Invariants 4 and 6 from the spec.

**Files:**
- Modify: `apps/api/tests/properties/commands.ts`
- Create: `apps/api/tests/properties/prefix.ts`

**Interfaces:**
- Consumes: `LedgerModel`, `Real`, `hasNegativeGuardedLeg`.
- Produces: `export async function assertGuardedPrefixes(model: LedgerModel, real: Real, pool: Pool): Promise<void>` — but see step 1: the cross-check runs through the repository, not the pool, so the signature is `(model, real)` and the repository call goes through a book-scoped transaction.

- [ ] **Step 1: Write the prefix cross-check**

Create `apps/api/tests/properties/prefix.ts`:

```ts
import { expect } from 'vitest';
import type { UnitOfWork } from '../../src/db/client.js';
import { isGuardedAccountType } from '../../src/domain/overdraft.js';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import type { LedgerModel } from './model.js';

/**
 * Invariant 4: no guarded account's minimum running balance is below zero, ever.
 *
 * Checked twice, by independent means. The model scans an array in `(occurredAt, seq)` order;
 * `lowestPrefixBalance` computes the same thing with a SQL window function over
 * `(occurred_at, id)`. That is not the rule written twice - it is one total order arrived at
 * two ways, and since the generator makes ties at equal `occurredAt` common on purpose, it is
 * the assertion that pins the tiebreaker stage 4's design argued for.
 */

const repository = new DrizzleLedgerRepository();

export async function assertGuardedPrefixes(
  model: LedgerModel,
  context: { bookId: string; unitOfWork: UnitOfWork },
): Promise<void> {
  for (const account of model.accounts) {
    if (!isGuardedAccountType(account.type)) continue;

    const expected = model.lowestPrefix(account.id);

    const actual = await context.unitOfWork.transactionInBook(context.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, account.id),
    );

    if (expected === null) {
      expect(actual, `${account.name} has no postings in the model`).toBeNull();
      continue;
    }

    expect(actual, `${account.name} has postings in the model but none in the database`).not.toBeNull();
    expect(actual?.balanceMinor, `lowest prefix of ${account.name}`).toBe(expected.balanceMinor);
    expect(actual?.occurredAt.getTime(), `when ${account.name} is lowest`).toBe(
      expected.occurredAt.getTime(),
    );

    expect(expected.balanceMinor, `${account.name} went overdrawn`).toBeGreaterThanOrEqual(0n);
  }
}
```

- [ ] **Step 2: Give the harness a unit of work to reach the repository through**

The `Real` handle currently carries only the service. Widen it in `apps/api/tests/properties/commands.ts`:

```ts
import type { UnitOfWork } from '../../src/db/client.js';

export interface Real {
  readonly bookId: string;
  readonly service: LedgerService;
  /** For the repository-level cross-check in `prefix.ts`. Nothing writes through it. */
  readonly unitOfWork: UnitOfWork;
}
```

In `apps/api/tests/properties/fixture.ts`, return the unit of work alongside the service. Change `createService(pool)` destructuring and the interface:

```ts
import { DrizzleUnitOfWork, createDatabase, type UnitOfWork } from '../../src/db/client.js';

export interface PropertyBook {
  readonly bookId: string;
  readonly accounts: readonly AccountRecord[];
  readonly service: LedgerService;
  readonly unitOfWork: UnitOfWork;
}
```

and inside `createPropertyBook`, replace `const { service } = createService(pool);` with:

```ts
  const { service } = createService(pool);
  // The same shape `createService` builds internally. Read-only here: the cross-check needs a
  // book-scoped transaction to reach `lowestPrefixBalance`, and nothing else uses it.
  const unitOfWork = new DrizzleUnitOfWork(createDatabase(pool));
```

and add `unitOfWork` to the returned object.

In `ledger.property.test.ts`, extend the `Real` literal:

```ts
        const real: Real = {
          bookId: book.bookId,
          service: book.service,
          unitOfWork: book.unitOfWork,
        };
```

- [ ] **Step 3: Add invariant 4 to the sweep and invariant 6 to `PostEntry`**

In `apps/api/tests/properties/commands.ts`, import the new pieces:

```ts
import { entrySpec, hasNegativeGuardedLeg, toPostEntryInput, type EntrySpec } from './arbitraries.js';
import { assertGuardedPrefixes } from './prefix.js';
```

At the end of `assertInvariants`, after the trial-balance block:

```ts
  // 4. No guarded account's minimum running balance is below zero.
  await assertGuardedPrefixes(model, { bookId: real.bookId, unitOfWork: real.unitOfWork });
```

In `PostEntryCommand.run`, replace the catch block:

```ts
    } catch (error) {
      if (!(error instanceof AccountOverdrawnError)) throw error;

      // 6. The one liveness claim in the set. An entry with no negative leg on a guarded
      // account cannot lower any prefix - all its legs share one `occurred_at`, its postings
      // take ids above every existing row - so refusing it is a defect, not a decision. This is
      // a consequence of the rule rather than a restatement of it: no prefix scan, no window
      // function, no knowledge of the account's history.
      expect(
        hasNegativeGuardedLeg(this.spec, model),
        `refused an entry that cannot lower any guarded prefix: ${this.toString()}`,
      ).toBe(true);

      this.tally.refused += 1;
    }
```

- [ ] **Step 4: Run it to verify it fails, then passes**

```bash
pnpm --filter @ledger/api exec vitest run --project properties
```

Expected first run: FAIL with `Cannot find module './prefix.js'` if step 1 was skipped, or a type error on `Real` if step 2 was.

Expected after all steps: PASS, 1 test. Slower than Task 5 — the sweep now issues one `lowestPrefixBalance` transaction per guarded account per command.

**If invariant 4 fails on the `occurredAt` comparison but agrees on `balanceMinor`**, the two implementations disagree about which of several equally-low points to report. That is a real finding about the tiebreaker and belongs in the corpus (Task 9) — report it rather than dropping the assertion.

- [ ] **Step 5: Commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/tests/properties
git commit -m "test(ledger): the prefix rule computed twice, and the entries it may never refuse"
```

---

### Task 7: The reversal command

Invariant 5.

**Files:**
- Modify: `apps/api/tests/properties/commands.ts`

**Interfaces:**
- Consumes: `LedgerModel.reversibleEntries`, `LedgerModel.markReversed`, `LedgerService.reverseEntry`.
- Produces: nothing new exported.

- [ ] **Step 1: Add the command**

In `apps/api/tests/properties/commands.ts`, add after `ReadTrialBalanceCommand`:

```ts
class ReverseEntryCommand implements LedgerCommand {
  constructor(
    private readonly index: number,
    private readonly tally: Tally,
  ) {}

  check(model: LedgerModel): boolean {
    // An entry may be reversed at most once, enforced by a partial unique index on
    // `reversal_of`. Picking only from the unreversed ones keeps the command valid rather than
    // making the harness assert about a conflict the generator caused.
    return model.reversibleEntries().length > 0;
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    const candidates = model.reversibleEntries();
    const original = candidates[this.index % candidates.length];
    if (original === undefined) return;

    // 5. A reversal changes each affected balance by exactly the negation of the original's
    // legs. The brief phrases this as "post an entry then reverse it restores the balance",
    // which is the special case where nothing landed in between; this form is stronger and
    // stays checkable in the middle of a sequence, which is where it actually runs.
    const before = new Map(
      model.accounts.map((account) => [account.id, model.balanceOf(account.id)]),
    );

    try {
      const reversal = await real.service.reverseEntry(real.bookId, original.id);

      model.record({
        id: reversal.id,
        occurredAt: reversal.occurredAt,
        legs: reversal.postings.map((posting) => ({
          accountId: posting.accountId,
          amountMinor: posting.amountMinor,
        })),
      });
      model.markReversed(original.id, reversal.id);

      const delta = new Map<string, bigint>();
      for (const leg of original.legs) {
        delta.set(leg.accountId, (delta.get(leg.accountId) ?? 0n) - leg.amountMinor);
      }

      for (const account of model.accounts) {
        const expected = (before.get(account.id) ?? 0n) + (delta.get(account.id) ?? 0n);
        expect(model.balanceOf(account.id), `${account.name} after reversing ${original.id}`).toBe(
          expected,
        );
      }
    } catch (error) {
      // The invariant is a property of the data, not of how the data arrived: a reversal that
      // would drive a guarded account short is refused like any other entry. Nothing is
      // recorded, no delta is asserted, and the entry stays reversible.
      if (!(error instanceof AccountOverdrawnError)) throw error;
      this.tally.refused += 1;
    }

    await assertInvariants(model, real);
  }

  toString(): string {
    return `ReverseEntry(#${this.index.toString()})`;
  }
}
```

- [ ] **Step 2: Register it**

In `ledgerCommands`, add to the array, after the second `PostEntryCommand` entry:

```ts
      fc.nat().map((index): LedgerCommand => new ReverseEntryCommand(index, tally)),
```

- [ ] **Step 3: Run it**

```bash
pnpm --filter @ledger/api exec vitest run --project properties
```

Expected: PASS, 1 test.

**If it fails on the delta assertion**, the reversal did not negate the original exactly — that is the finding this command exists to make, and it goes in the corpus (Task 9) before anything is changed.

- [ ] **Step 4: Commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/tests/properties/commands.ts
git commit -m "test(ledger): a reversal's delta is the negation of its original, mid-sequence"
```

---

### Task 8: The postings-page command

The running balance in cursor order — the one place a correct total can be assembled from wrong parts.

**Files:**
- Modify: `apps/api/tests/properties/commands.ts`

- [ ] **Step 1: Add the command**

In `apps/api/tests/properties/commands.ts`, add after `ReverseEntryCommand`:

```ts
class ReadPostingsCommand implements LedgerCommand {
  constructor(private readonly index: number) {}

  check(model: LedgerModel): boolean {
    return model.accounts.length > 0;
  }

  async run(model: LedgerModel, real: Real): Promise<void> {
    const account = model.accounts[this.index % model.accounts.length];
    if (account === undefined) return;

    // A small page on purpose: the running balance of page two opens from a fresh
    // sum-from-zero up to the cursor, and a page size that never forces a second page would
    // never exercise it.
    const collected: { id: bigint; amountMinor: bigint; runningBalance: bigint }[] = [];
    let cursor: string | undefined;

    do {
      const page = await real.service.listPostings(real.bookId, account.id, {
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });

      for (const item of page.items) {
        collected.push({
          id: item.id,
          amountMinor: item.amount.amountMinor,
          runningBalance: item.runningBalance.amountMinor,
        });
      }

      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    // The page set is the account's postings, no more and no fewer.
    const expectedAmounts = model
      .postingsOf(account.id)
      .slice()
      .sort((left, right) => left.seq - right.seq)
      .map((posting) => posting.amountMinor);

    expect(
      collected.map((line) => line.amountMinor),
      `postings listed for ${account.name}`,
    ).toEqual(expectedAmounts);

    // Every row's running balance is the true prefix sum in cursor order. Checking only the
    // last row would pass for a page that got every intermediate value wrong and happened to
    // end in the right place.
    let running = 0n;
    for (const [position, line] of collected.entries()) {
      running += line.amountMinor;
      expect(
        line.runningBalance,
        `running balance at row ${position.toString()} of ${account.name}`,
      ).toBe(running);
    }

    // Cursor order is posting-id order, which is insertion order and not `occurred_at` order.
    const ids = collected.map((line) => line.id);
    expect([...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))).toEqual(ids);

    await assertInvariants(model, real);
  }

  toString(): string {
    return `ReadPostings(#${this.index.toString()})`;
  }
}
```

- [ ] **Step 2: Register it**

In `ledgerCommands`, add after the `ReadBalanceCommand` entry:

```ts
      fc.nat().map((index): LedgerCommand => new ReadPostingsCommand(index)),
```

- [ ] **Step 3: Run it**

```bash
pnpm --filter @ledger/api exec vitest run --project properties
```

Expected: PASS, 1 test.

Note the ordering claim in the last assertion: `listPostings` pages by posting id, so an entry backdated to January that was *recorded* last appears at the end of the list, not the start. If that assertion fails, check which order the endpoint actually promises before assuming the code is wrong.

- [ ] **Step 4: Commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/tests/properties/commands.ts
git commit -m "test(ledger): every row of a paged statement, not only the last one"
```

---

### Task 9: The boundary property

One narrow property over the HTTP layer: an amount's full trip.

**Files:**
- Create: `apps/api/tests/properties/http.property.test.ts`

**Interfaces:**
- Consumes: `createTestApplication` (`tests/helpers/app.js`), `registerUser`, `createBook`, `createAccount`, `bearer` (`tests/helpers/http.js`).

- [ ] **Step 1: Write the property**

Create `apps/api/tests/properties/http.property.test.ts`:

```ts
import { formatMoney, money } from '@ledger/shared';
import fc from 'fast-check';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApplication, type TestApplication } from '../helpers/app.js';
import { bearer, createAccount, createBook, registerUser } from '../helpers/http.js';
import { propertyRuns } from './runs.js';

/**
 * An amount's full trip: decimal string, bigint, numeric, bigint, decimal string.
 *
 * Stage 3's tests cover the route layer's status codes, validation and problem documents, and
 * they stay there. What no example test can cover by enumeration is that an *arbitrary* amount
 * survives this chain - and it is the one path in the system where a JS `number` could appear
 * without any single layer noticing, because every layer would still be handling a value that
 * looks entirely plausible.
 *
 * Deliberately one property. A second command harness at this layer would cost minutes per run
 * and duplicate what `ledger.property.test.ts` already asserts about the ledger itself.
 */

/**
 * Past `Number.MAX_SAFE_INTEGER`, which is 9_007_199_254_740_991: a value above it that has
 * been through a double comes back changed, and this is the range where that shows.
 */
const AMOUNT_MINOR = fc.bigInt({ min: 1n, max: 10n ** 24n });

describe('an amount across the HTTP boundary', () => {
  it('round-trips through post and read, at any magnitude', async () => {
    const application: TestApplication = createTestApplication();
    const owner = await registerUser(application);
    const book = await createBook(application, owner);

    // The guarded account takes the positive leg and the unguarded one takes the negative, so
    // the overdraft rule never fires. This property is about arithmetic, not about the rule:
    // a refusal here would stop it measuring what it exists to measure.
    const debit = await createAccount(application, book, { name: 'Receivable', type: 'asset' });
    const credit = await createAccount(application, book, { name: 'Revenue', type: 'revenue' });

    // The account accumulates across cases, so the expected balance has to as well. Correct
    // only because every case posts: the sole refusal available is an overdraft, and `debit`
    // never receives a negative leg. Shrinking replays smaller amounts against a balance that
    // has already moved, which this handles and a per-case constant would not.
    let expectedMinor = 0n;

    await fc.assert(
      fc.asyncProperty(AMOUNT_MINOR, async (amountMinor) => {
        const amount = formatMoney(money(amountMinor, 'EUR'));
        const negated = formatMoney(money(-amountMinor, 'EUR'));

        const posted = await request(application.app)
          .post(`/books/${book.bookId}/entries`)
          .set('Authorization', bearer(owner.accessToken))
          .send({
            occurredAt: '2026-04-01T00:00:00.000Z',
            description: 'boundary property',
            legs: [
              { accountId: debit, amount, currency: 'EUR' },
              { accountId: credit, amount: negated, currency: 'EUR' },
            ],
          });

        expect(posted.status, JSON.stringify(posted.body)).toBe(201);
        expectedMinor += amountMinor;

        const balance = await request(application.app)
          .get(`/accounts/${debit}/balance`)
          .set('Authorization', bearer(owner.accessToken));

        expect(balance.status).toBe(200);
        expect(balance.body.balance.amount).toBe(formatMoney(money(expectedMinor, 'EUR')));
        expect(balance.body.balance.currency).toBe('EUR');
      }),
      { numRuns: propertyRuns(15) },
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @ledger/api exec vitest run --project properties http.property
```

Expected: FAIL with `Cannot find module './http.property.test.js'`-style resolution errors only if a helper import is wrong. Otherwise it passes — as with Tasks 1 and 2, green is the expected outcome here.

- [ ] **Step 3: Run it to verify it passes**

```bash
pnpm --filter @ledger/api exec vitest run --project properties http.property
```

Expected: PASS, 1 test.

**If it fails at a large magnitude**, an amount lost precision somewhere in the chain. That is exactly what this property is for — capture the value and put it in the corpus (Task 11) before touching anything.

- [ ] **Step 4: Commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/tests/properties/http.property.test.ts
git commit -m "test(http): an arbitrary amount survives the round trip through the API"
```

---

### Task 10: The concurrent property

**Files:**
- Modify: `apps/api/tests/helpers/concurrency.ts`
- Create: `apps/api/tests/concurrency/conservation.property.test.ts`

**Interfaces:**
- Consumes: `fundedBook`, `Book`, `balanceOf`, `createService`.
- Produces:
  ```ts
  export interface TransferSpec { readonly fromAccountId: string; readonly toAccountId: string; readonly amountMinor: bigint }
  export function fireTransfers(service: LedgerService, book: Book, transfers: readonly TransferSpec[]): Promise<{ accepted: number; rejected: number; errors: unknown[] }>
  ```

- [ ] **Step 1: Generalize the firing helper**

In `apps/api/tests/helpers/concurrency.ts`, add below `fireConcurrently` (leave `fireConcurrently` in place — `overdraft.race.test.ts` depends on it):

```ts
/** One transfer between two accounts of the same currency. */
export interface TransferSpec {
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountMinor: bigint;
}

/**
 * Fires an arbitrary batch of transfers at once and reports how each ended.
 *
 * `fireConcurrently` fires N copies of one withdrawal, which is the right shape for a test
 * about a known race. This takes a list, because a property generates the batch rather than
 * repeating it, and the interesting batches are the uneven ones.
 */
export async function fireTransfers(
  service: LedgerService,
  book: Book,
  transfers: readonly TransferSpec[],
): Promise<{ accepted: number; rejected: number; errors: unknown[] }> {
  const attempts = transfers.map((transfer, index) =>
    service.postEntry(book.bookId, {
      occurredAt: '2026-02-01T00:00:00.000Z',
      description: `concurrent transfer ${index.toString()}`,
      legs: [
        {
          accountId: transfer.fromAccountId,
          amount: decimal(-transfer.amountMinor),
          currency: 'EUR',
        },
        { accountId: transfer.toAccountId, amount: decimal(transfer.amountMinor), currency: 'EUR' },
      ],
    }),
  );

  const settled = await Promise.allSettled(attempts);

  return {
    accepted: settled.filter((result) => result.status === 'fulfilled').length,
    rejected: settled.filter((result) => result.status === 'rejected').length,
    errors: settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
  };
}
```

- [ ] **Step 2: Write the property**

Create `apps/api/tests/concurrency/conservation.property.test.ts`:

```ts
import fc from 'fast-check';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { ConcurrencyStrategy } from '../../src/db/client.js';
import { SQLSTATE, hasSqlState } from '../../src/db/pg-errors.js';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import { fireTransfers, fundedBook, type TransferSpec } from '../helpers/concurrency.js';
import { balanceOf, queryInBook } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * Value conservation and the overdraft rule, over generated batches fired for real.
 *
 * `fc.scheduler` shrinks interleavings of JS `await` points, and would be the reproducible
 * option - but the thing stage 4 proved dangerous was Postgres commit ordering under READ
 * COMMITTED, which no JavaScript scheduler observes or controls. So the generator picks the
 * batch *shape* and the harness fires it over real pool connections, keeping the subject
 * intact and giving up deterministic replay.
 *
 * The outcome is legitimately nondeterministic - which transfers win is a race - so every
 * assertion here is about what must hold whichever subset commits.
 */

const OPENING = 50_000n;
const STRATEGIES: readonly ConcurrencyStrategy[] = ['row-lock', 'serializable'];

/** Low: each case is a fresh funded book plus up to eight overlapping transactions. */
const RUNS = 15;

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 20 });
});

afterAll(async () => {
  await pool.end();
});

describe.each(STRATEGIES)('a generated concurrent batch under %s', (strategy) => {
  it('conserves value and never overdraws, whichever transfers win', async () => {
    const { service } = createService(pool, { strategy });

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1_000n, max: 30_000n }), { minLength: 2, maxLength: 8 }),
        async (amounts) => {
          const book = await fundedBook(pool, service, OPENING);

          // Every transfer drains the one guarded account, which is what makes the batch
          // collectively unaffordable while each is individually fine - the shape stage 4's
          // race needs, generated rather than fixed.
          const transfers: TransferSpec[] = amounts.map((amountMinor) => ({
            fromAccountId: book.cash,
            toAccountId: book.rent,
            amountMinor,
          }));

          const outcome = await fireTransfers(service, book, transfers);

          for (const error of outcome.errors) {
            const acceptable =
              error instanceof AccountOverdrawnError ||
              (strategy === 'serializable' &&
                hasSqlState(error, SQLSTATE.SERIALIZATION_FAILURE));

            expect(acceptable, `unexpected rejection: ${String(error)}`).toBe(true);
          }

          const cash = await balanceOf(pool, book.bookId, book.cash);
          const rent = await balanceOf(pool, book.bookId, book.rent);
          const sales = await balanceOf(pool, book.bookId, book.sales);

          // Value conserved: the book still sums to zero.
          expect(cash + rent + sales, 'the book stopped summing to zero').toBe(0n);

          // The rule held. The final balance is also the *minimum prefix* here, which is the
          // form the rule actually takes: every transfer is negative on `cash` and they all
          // share one `occurred_at`, so the running total only ever falls and its lowest point
          // is where it ends. A batch with positive legs would need the prefix query instead.
          expect(cash, 'the guarded account went negative').toBeGreaterThanOrEqual(0n);

          // Every fulfilled call committed an entry, and every rejected one committed none.
          // Without this, a run in which every transfer failed would satisfy both assertions
          // above - which is the shape every failure mode here actually takes.
          const rows = await queryInBook<{ count: string }>(
            pool,
            book.bookId,
            "SELECT count(*)::text AS count FROM entries WHERE description LIKE 'concurrent transfer%'",
          );

          expect(Number(rows[0]?.count ?? '0'), 'committed entries against fulfilled calls').toBe(
            outcome.accepted,
          );
        },
      ),
      { numRuns: RUNS },
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
pnpm --filter @ledger/api exec vitest run --project concurrency conservation
```

Expected: FAIL with `fireTransfers is not exported` if step 1 was skipped.

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @ledger/api exec vitest run --project concurrency
```

Expected: PASS — 2 cases of the new property plus the three existing `overdraft.race` tests. Run the whole project, not just the new file: `fireConcurrently` was left in place and the existing race test must still pass.

- [ ] **Step 5: Commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/tests/helpers/concurrency.ts apps/api/tests/concurrency/conservation.property.test.ts
git commit -m "test(concurrency): generated batches, conserved value, and no lost commits"
```

---

### Task 11: The regression corpus

Last of the test tasks, because it wires into the two properties whose inputs can be written
down by hand — which is not all of them. See the note in the module about why.

**Files:**
- Create: `apps/api/tests/properties/regressions.ts`
- Modify: `apps/api/tests/properties/http.property.test.ts`
- Modify: `apps/api/tests/concurrency/conservation.property.test.ts`

- [ ] **Step 1: Write the corpus module**

Create `apps/api/tests/properties/regressions.ts`:

```ts
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

/** Amounts that broke the HTTP round trip. Tuples matching `AMOUNT_MINOR` in `http.property.test.ts`. */
export const HTTP_AMOUNT_EXAMPLES: readonly [bigint][] = [];

/** Batch shapes that broke conservation. Tuples matching the amounts array in `conservation.property.test.ts`. */
export const CONCURRENT_BATCH_EXAMPLES: readonly [bigint[]][] = [];
```

- [ ] **Step 2: Wire it into the boundary property**

In `apps/api/tests/properties/http.property.test.ts`, add the import:

```ts
import { HTTP_AMOUNT_EXAMPLES } from './regressions.js';
```

and extend the `fc.assert` options:

```ts
      // The corpus replays before anything is generated. Empty today, and free until it is not.
      { numRuns: propertyRuns(15), examples: HTTP_AMOUNT_EXAMPLES },
```

- [ ] **Step 3: Wire it into the concurrent property**

In `apps/api/tests/concurrency/conservation.property.test.ts`, add the import:

```ts
import { CONCURRENT_BATCH_EXAMPLES } from '../properties/regressions.js';
```

and extend the `fc.assert` options:

```ts
      // The corpus replays before anything is generated. It is also the only reproducibility
      // this property has: the batch shape is generated, but which transfer wins is a race, so
      // a failing shape is worth pinning even though replaying it may not fail again.
      { numRuns: RUNS, examples: CONCURRENT_BATCH_EXAMPLES },
```

Note the import crosses project directories — `tests/concurrency/` reaching into
`tests/properties/`. That is deliberate: one corpus, not two, and the vitest projects are a
scheduling boundary rather than a module boundary.

- [ ] **Step 4: Run both projects**

```bash
pnpm --filter @ledger/api exec vitest run --project properties --project concurrency
```

Expected: PASS. Empty `examples` arrays change nothing about either run, which is the point — the mechanism is in place and costs nothing until it holds something.

- [ ] **Step 5: Commit**

```bash
pnpm lint
pnpm typecheck
git add apps/api/tests/properties/regressions.ts apps/api/tests/properties/http.property.test.ts apps/api/tests/concurrency/conservation.property.test.ts
git commit -m "test(ledger): a corpus for shrunk counterexamples, empty until one is found"
```

---

### Task 12: The README section, and the full run

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run everything**

```bash
pnpm test
```

Expected: every project green — `unit`, `integration`, `concurrency`, `properties`, and `@ledger/shared`. This is the first run where all four api projects and the shared package execute together; note the total wall time, since the README quotes it.

- [ ] **Step 2: Run the properties hard, once**

```bash
LEDGER_PROPERTY_RUNS=200 pnpm --filter @ledger/api exec vitest run --project properties
```

Expected: PASS. This is the run that has a real chance of finding something. If it fails:

1. Do not change production code yet.
2. Copy the shrunk counterexample fast-check printed.
3. Transcribe it into `apps/api/tests/properties/regressions.ts` with a comment naming the defect.
4. Write the story into the README section below.
5. Then fix the defect, in its own commit, and confirm the corpus case goes from red to green.

- [ ] **Step 3: Write the README section**

Add to `README.md`, after the existing testing section:

```markdown
### Property-based tests

Four suites of example tests pin the cases someone thought of. `tests/properties/` states the
same invariants as properties and lets fast-check look for the cases nobody thought of, against
the real database rather than a model of it.

An `fc.commands` sequence drives `LedgerService` — post, reverse, read a balance, page through
postings, read the trial balance — while an in-memory model is advanced alongside it. After
every command:

1. the book sums to zero in every currency
2. every balance equals the sum of that account's own postings
3. the trial balance agrees, account by account, and its debits equal its credits
4. no guarded account's minimum running balance is below zero — computed twice, once by a SQL
   window function and once by an array scan, which is what pins the `(occurred_at, id)`
   tiebreaker
5. a reversal changes each affected balance by exactly the negation of the original's legs

The model **follows**: it records what the service accepted and never predicts a refusal, so the
overdraft rule is not written a third time after the SQL in migration 0007 and the check in the
service. The price is that a service refusing everything would satisfy all five, so a sixth
invariant asserts the one class of entry that is *provably* acceptable — one carrying no negative
leg on a guarded account cannot lower any prefix — and a coverage tally across the run asserts
that acceptances stay the clear majority.

`LEDGER_PROPERTY_RUNS` sets the case count; it defaults to 25 so `pnpm test` stays usable.

**The corpus.** `tests/properties/regressions.ts` holds counterexamples this suite has found,
transcribed and replayed on every run through fast-check's `examples` option. It is currently
empty — the properties have not yet found a defect, and nothing was planted here to demonstrate
the mechanism.

**Query counting.** `tests/services/query-count.test.ts` measures the statements a read path
actually sends, at the driver rather than through the ORM, and asserts that `listPostings` sends
the same statements for a page of 1 as for a page of 50 and that `trialBalance` is invariant to
account count. An N+1 returns exactly the right answer, just once per row, so it is invisible to
every other test in the suite.
```

If step 2 found something, replace the corpus paragraph with the story instead: what the property
generated, what shrinking reduced it to, and what was wrong.

- [ ] **Step 4: Commit**

```bash
pnpm lint
pnpm typecheck
git add README.md
git commit -m "docs: what the property suite asserts, and what its corpus holds"
```

---

## Self-review notes

**Spec coverage.** Every section of the spec maps to a task: the harness and model (4), the six
invariants (4–8), the commands (5, 7, 8), the generators (4), the pure properties (1, 2), the
boundary property (9), the concurrent property (10), query counting (3), the corpus (11), the
README (12).

**The corpus covers two of the three properties, deliberately.** `fc.gen()` inputs cannot be
written down as `examples`, so a counterexample from the command property is transcribed as a
hand-written replay test instead. Task 11's module says so and says how.

**Deliberately deferred to execution, not left vague:**

- The exact statement counts in Task 3 (5 and 6) are derived, not measured. Task 3 step 3 says
  how to correct them and forbids encoding a round trip that looks unnecessary.
- The accept/refuse balance in Task 5 depends on `MAX_LEG_MINOR` against `OPENING_MINOR`. Task 5
  step 3 says which knob to move and forbids relaxing the assertion.

**Not in scope, per the spec's non-goals:** `EXPLAIN ANALYZE`, indexes, balance checkpoints
(stage 7); the frontend (stage 6); any change to production code. If a property finds a defect,
fixing it is a separate commit — the plan's tasks are all tests.
