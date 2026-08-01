# Stage 4 Overdraft Rule and Concurrency Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `asset` account may not hold a negative balance at any point in its history, enforced in the service and in the database, with the concurrency failure of the naive implementation committed as reproducible evidence and two correct fixes compared in an ADR.

**Architecture:** A guarded account's postings, ordered by `(occurred_at, posting id)`, must have every prefix sum non-negative. The check is one window query per guarded account carrying a negative leg, run inside the posting transaction after the insert. Correctness under concurrency comes from `SELECT ... FOR UPDATE` on the account rows, acquired in sorted id order before the insert; a `SERIALIZABLE`-plus-retry strategy is built and tested alongside it for the ADR but is not the default.

**Tech Stack:** TypeScript (ESM, NodeNext), Express 5, drizzle-orm 0.45 over node-postgres, Postgres 16, zod 4, vitest 4 with testcontainers.

Design spec: [`docs/superpowers/specs/2026-07-31-stage-4-overdraft-design.md`](../specs/2026-07-31-stage-4-overdraft-design.md).

## Global Constraints

- Amounts are `bigint` in TypeScript and decimal strings at the HTTP boundary. Never a JS `number`, not even briefly, not even in a test. SQL sums are cast `::text` and converted with `BigInt()`.
- `process.env` is read in `src/config.ts` only. An ESLint rule enforces this.
- Domain errors carry no HTTP status. `STATUS` in `src/http/error-middleware.ts` is typed `Record<DomainErrorCode, Mapping>`, so a new code without a status entry is a compile error.
- Every statement touching `accounts`, `entries` or `postings` runs inside a transaction that has established `app.current_book_id`. Outside one, row-level security returns zero rows rather than raising.
- Integration tests get connection strings from `inject('appUrl')` (runtime role) and `inject('ownerUrl')` (schema owner). Each test seeds its own book; there is no teardown, because history cannot be deleted.
- Migration files are hand-written SQL in `apps/api/drizzle/`, with `--> statement-breakpoint` between statements, and are registered in `drizzle/meta/_journal.json`.
- Commit messages: `type(scope): lowercase summary`. No attribution footer.
- Run from `apps/api/` unless stated otherwise.

---

### Task 1: The guarded types, the error, and its HTTP status

**Files:**
- Create: `apps/api/src/domain/overdraft.ts`
- Modify: `apps/api/src/domain/errors.ts`
- Modify: `apps/api/src/http/problem.ts`
- Modify: `apps/api/src/http/error-middleware.ts`
- Test: `apps/api/tests/unit/overdraft.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GUARDED_ACCOUNT_TYPES: readonly ['asset']`, `type AccountType`, `isGuardedAccountType(type: AccountType): boolean`, `AccountOverdrawnError`, and the `ACCOUNT_OVERDRAWN` member of `DomainErrorCode`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/unit/overdraft.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import { GUARDED_ACCOUNT_TYPES, isGuardedAccountType } from '../../src/domain/overdraft.js';

describe('guarded account types', () => {
  it('guards assets and nothing else', () => {
    expect([...GUARDED_ACCOUNT_TYPES]).toEqual(['asset']);
    expect(isGuardedAccountType('asset')).toBe(true);

    for (const type of ['liability', 'equity', 'revenue', 'expense'] as const) {
      expect(isGuardedAccountType(type)).toBe(false);
    }
  });
});

describe('AccountOverdrawnError', () => {
  it('names the account, the shortfall and when it happens', () => {
    const error = new AccountOverdrawnError(
      'acct-1',
      { currency: 'EUR', amountMinor: -250n },
      new Date('2026-03-01T12:00:00.000Z'),
    );

    expect(error.code).toBe('ACCOUNT_OVERDRAWN');
    expect(error.message).toContain('acct-1');
    expect(error.message).toContain('-250');
    expect(error.message).toContain('2026-03-01T12:00:00.000Z');
  });

  it('says the database caught it when there is no detail', () => {
    const error = new AccountOverdrawnError('acct-1', null, null);

    expect(error.shortfall).toBeNull();
    expect(error.message).toContain('at COMMIT');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api exec vitest run --project unit tests/unit/overdraft.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/domain/overdraft.js"`.

- [ ] **Step 3: Create the guarded-types module**

Create `apps/api/src/domain/overdraft.ts`:

```ts
/**
 * Which accounts may not go negative.
 *
 * An account type rather than a per-account flag, and hardcoded rather than configured:
 * the rule is a fact about what an asset is - a cash box holds no negative euros - not a
 * product setting. A per-account `overdraft_limit_minor` is a later addition that changes
 * nothing about how the rule is enforced concurrently, which is what this stage is about.
 *
 * Mirrored by `guarded_account_types()` in migration 0007. That duplication is deliberate,
 * for the same reason `policy.ts` duplicates the `book_role` enum: the database has to be
 * able to enforce the rule without asking this process. `tests/db/overdraft.trigger.test.ts`
 * asserts the two agree, so the copy cannot drift.
 */

/**
 * The five account types, matching the `account_type` enum in `db/schema.ts`.
 *
 * Written out here rather than imported, so `domain/` keeps depending on nothing - the same
 * discipline `policy.ts` follows. The unit test below compares this list against the enum's
 * own values, which is what makes the structural copy safe.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/** Account types that may not hold a negative balance at any point in their history. */
export const GUARDED_ACCOUNT_TYPES = ['asset'] as const satisfies readonly AccountType[];

const GUARDED: ReadonlySet<string> = new Set(GUARDED_ACCOUNT_TYPES);

export function isGuardedAccountType(type: AccountType): boolean {
  return GUARDED.has(type);
}
```

- [ ] **Step 4: Add the error**

In `apps/api/src/domain/errors.ts`, add `'ACCOUNT_OVERDRAWN'` to the `DomainErrorCode` union, immediately after `'ENTRY_ALREADY_REVERSED'`:

```ts
  | 'ENTRY_ALREADY_REVERSED'
  | 'ACCOUNT_OVERDRAWN'
```

Then append this class to the end of the file:

```ts
/**
 * A guarded account would be left negative at some point in its history.
 *
 * Not only at the end. `occurred_at` is asserted by the caller, so an entry recorded today
 * can land in the past; a rule that constrained only the current balance would accept a
 * backdated withdrawal that overdrew the account on the date it claims to describe. The
 * check is over every prefix of the account's postings, ordered by `(occurred_at, id)`.
 *
 * Reversals are not exempt. An entry that cannot be reversed without breaking this is an
 * entry whose reversal alone is not the correction - so the error carries the shortfall,
 * which is exactly what has to be deposited first.
 */
export class AccountOverdrawnError extends DomainError {
  readonly code = 'ACCOUNT_OVERDRAWN';

  constructor(
    readonly accountId: string,
    /**
     * How far below zero the balance falls, and in which currency. Null when the database
     * raised LG004 rather than the application check: the trigger knows the number and this
     * process does not, the same way `UnbalancedEntryError` handles LG001.
     */
    readonly shortfall: CurrencyImbalance | null,
    /** When the balance first goes short. Null for the same reason as `shortfall`. */
    readonly occurredAt: Date | null,
    options?: { cause?: unknown },
  ) {
    super(
      shortfall === null
        ? `account ${accountId} would be overdrawn: rejected by the database at COMMIT`
        : `account ${accountId} would be overdrawn: its balance reaches ` +
          `${shortfall.amountMinor.toString()} ${shortfall.currency}` +
          `${occurredAt === null ? '' : ` at ${occurredAt.toISOString()}`}`,
      options,
    );
  }
}
```

- [ ] **Step 5: Let a problem document carry extensions**

In `apps/api/src/http/problem.ts`, add an extensions bag. Change `ProblemDocument` and `ProblemInput` and the `problem()` body:

```ts
export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  /** The path that produced it. */
  readonly instance: string;
  readonly code: ProblemCode;
  readonly requestId: string;
  /** Field-level detail, on validation failures only. */
  readonly errors?: readonly ProblemDetail[];
  /** Error-specific members. RFC 9457 allows these; see `error-middleware.ts`. */
  readonly [member: string]: unknown;
}

export interface ProblemInput {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly code: ProblemCode;
  readonly instance: string;
  readonly requestId: string;
  readonly errors?: readonly ProblemDetail[] | undefined;
  /**
   * Extra members, merged in last. RFC 9457 calls these extension members and permits them
   * explicitly; they are what lets a client react to an overdraft without parsing `detail`.
   */
  readonly extensions?: Readonly<Record<string, unknown>> | undefined;
}

export function problem(input: ProblemInput): ProblemDocument {
  return {
    type: `${PROBLEM_TYPE_BASE}${toSlug(input.code)}`,
    title: input.title,
    status: input.status,
    detail: input.detail,
    instance: input.instance,
    code: input.code,
    requestId: input.requestId,
    ...(input.errors !== undefined && input.errors.length > 0 ? { errors: input.errors } : {}),
    ...(input.extensions ?? {}),
  };
}
```

- [ ] **Step 6: Map the code to 422 and populate the extensions**

In `apps/api/src/http/error-middleware.ts`, add to the 422 block of `STATUS`:

```ts
  ACCOUNT_OVERDRAWN: { status: 422, title: 'Account would be overdrawn' },
```

Import the error and `formatMoney`:

```ts
import { formatMoney, money } from '@ledger/shared';
import { AccountOverdrawnError, DomainError, ValidationError, type DomainErrorCode } from '../domain/errors.js';
```

In the `error instanceof DomainError` branch, pass extensions:

```ts
      response
        .status(status)
        .type(PROBLEM_CONTENT_TYPE)
        .json(
          problem({
            status,
            title,
            detail: error.message,
            code: error.code,
            instance,
            requestId,
            errors: error instanceof ValidationError ? toProblemDetails(error) : undefined,
            extensions: extensionsOf(error),
          }),
        );
      return;
```

And add the helper beside `toProblemDetails`:

```ts
/**
 * Error-specific members of the problem document.
 *
 * Only the overdraft has any, and it needs them: "how short is it" is the one question a
 * client asks next, and making them parse it out of `detail` would be making them parse
 * English. The amount goes out as a decimal string like every other amount at this
 * boundary - a JSON number would be a double.
 */
function extensionsOf(error: DomainError): Readonly<Record<string, unknown>> | undefined {
  if (!(error instanceof AccountOverdrawnError)) return undefined;

  return {
    accountId: error.accountId,
    shortfall:
      error.shortfall === null
        ? null
        : formatMoney(money(error.shortfall.amountMinor, error.shortfall.currency)),
    currency: error.shortfall?.currency ?? null,
    occurredAt: error.occurredAt?.toISOString() ?? null,
  };
}
```

- [ ] **Step 7: Add the enum-agreement test**

Append to `apps/api/tests/unit/overdraft.test.ts`:

```ts
import { accountType } from '../../src/db/schema.js';

describe('AccountType', () => {
  it('lists exactly the values of the account_type enum', () => {
    expect([...GUARDED_ACCOUNT_TYPES].every((type) => accountType.enumValues.includes(type))).toBe(
      true,
    );
    expect([...accountType.enumValues].sort()).toEqual(
      ['asset', 'equity', 'expense', 'liability', 'revenue'].sort(),
    );
  });
});
```

- [ ] **Step 8: Run the unit project and the typechecker**

```bash
pnpm --filter @ledger/api exec vitest run --project unit
```

Expected: PASS, including the existing `tests/unit/problem.test.ts`.

```bash
pnpm --filter @ledger/api typecheck
```

Expected: no output, exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/domain/overdraft.ts apps/api/src/domain/errors.ts apps/api/src/http/problem.ts apps/api/src/http/error-middleware.ts apps/api/tests/unit/overdraft.test.ts
git commit -m "feat(domain): the guarded account types and the overdraft error"
```

---

### Task 2: The prefix-balance query

**Files:**
- Modify: `apps/api/src/repositories/ledger.repository.ts`
- Test: `apps/api/tests/db/overdraft.prefix.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `LowestPrefix { balanceMinor: bigint; occurredAt: Date }` and `LedgerRepository.lowestPrefixBalance(executor, accountId): Promise<LowestPrefix | null>`, returning `null` for an account with no postings.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/db/overdraft.prefix.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, DrizzleUnitOfWork } from '../../src/db/client.js';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import { insertEntry, seedBook, withClient, type Book } from '../helpers/ledger.js';

/**
 * The window query, against a real Postgres. The interesting cases are all about ordering -
 * `occurred_at` is caller-asserted, so postings do not arrive in the order they happened -
 * and no fake could answer them.
 */

let pool: Pool;
let repository: DrizzleLedgerRepository;
let unitOfWork: DrizzleUnitOfWork;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 4 });
  repository = new DrizzleLedgerRepository();
  unitOfWork = new DrizzleUnitOfWork(createDatabase(pool));
});

afterAll(async () => {
  await pool.end();
});

/** Seeds a book and commits the given entries, each at its own `occurred_at`. */
async function bookWith(
  entries: readonly { occurredAt: string; amountMinor: bigint }[],
): Promise<Book> {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    const book = await seedBook(client);

    for (const entry of entries) {
      const entryId = await insertEntry(client, book, [
        { accountId: book.cash, amountMinor: entry.amountMinor },
        { accountId: book.sales, amountMinor: -entry.amountMinor },
      ]);
      await client.query('UPDATE entries SET occurred_at = $1 WHERE id = $2', [
        entry.occurredAt,
        entryId,
      ]);
    }

    await client.query('COMMIT');
    return book;
  });
}

describe('lowestPrefixBalance', () => {
  it('is null for an account with no postings', async () => {
    const book = await bookWith([]);

    const lowest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, book.cash),
    );

    expect(lowest).toBeNull();
  });

  it('is the running minimum, not the final balance', async () => {
    // +500, then -800, then +1000: ends at +700, dips to -300 in the middle.
    const book = await bookWith([
      { occurredAt: '2026-01-01T00:00:00.000Z', amountMinor: 500n },
      { occurredAt: '2026-02-01T00:00:00.000Z', amountMinor: -800n },
      { occurredAt: '2026-03-01T00:00:00.000Z', amountMinor: 1000n },
    ]);

    const lowest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, book.cash),
    );

    expect(lowest?.balanceMinor).toBe(-300n);
    expect(lowest?.occurredAt.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('orders by occurred_at, not by insertion order', async () => {
    // The withdrawal is recorded second but happened first, so it dips below zero.
    const book = await bookWith([
      { occurredAt: '2026-02-01T00:00:00.000Z', amountMinor: 500n },
      { occurredAt: '2026-01-01T00:00:00.000Z', amountMinor: -200n },
    ]);

    const lowest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, book.cash),
    );

    expect(lowest?.balanceMinor).toBe(-200n);
    expect(lowest?.occurredAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('breaks ties on posting id, so the same instant has one answer', async () => {
    // Same instant: -200 then +500 dips, +500 then -200 does not. Insertion order decides.
    const book = await bookWith([
      { occurredAt: '2026-01-01T00:00:00.000Z', amountMinor: -200n },
      { occurredAt: '2026-01-01T00:00:00.000Z', amountMinor: 500n },
    ]);

    const lowest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.lowestPrefixBalance(tx, book.cash),
    );

    expect(lowest?.balanceMinor).toBe(-200n);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api exec vitest run --project integration tests/db/overdraft.prefix.test.ts
```

Expected: FAIL — `repository.lowestPrefixBalance is not a function`. (First run pulls the `postgres:16-alpine` image and takes about a minute.)

- [ ] **Step 3: Add the type and the interface method**

In `apps/api/src/repositories/ledger.repository.ts`, add after `TrialBalanceRow`:

```ts
/**
 * The lowest the account's balance ever gets, and when. `balanceMinor` is a running total,
 * not a single posting: it is the sum of every posting up to and including that point.
 */
export interface LowestPrefix {
  readonly balanceMinor: bigint;
  readonly occurredAt: Date;
}
```

And to the `LedgerRepository` interface, after `sumPostingsThrough`:

```ts
  /**
   * The minimum running balance over the account's history, or null if it has no postings.
   * The overdraft rule is exactly `balanceMinor >= 0`.
   */
  lowestPrefixBalance(executor: Executor, accountId: string): Promise<LowestPrefix | null>;
```

- [ ] **Step 4: Implement it**

Add to `DrizzleLedgerRepository`, after `sumPostingsThrough`:

```ts
  /**
   * The lowest point the account's balance ever reaches.
   *
   * A window function rather than a sum, because the overdraft rule is about every prefix of
   * the account's history and not about its total. Those differ precisely when an entry is
   * backdated - which `occurred_at` exists to allow - and the difference is a withdrawal that
   * overdrew the account on the date it claims to describe while today's balance looks fine.
   *
   * `ORDER BY e.occurred_at, p.id`, and the tiebreaker is load-bearing. Two legs of one entry
   * always share an `occurred_at`, so without it the window has no defined order among them
   * and "the minimum prefix" is not a single number. `p.id` is a bigserial: a total order,
   * consistent with the sequence rows were recorded in.
   *
   * Raw SQL rather than the query builder because drizzle has no window-function API, and
   * writing it out is clearer than assembling it from fragments. It reads only `postings` and
   * `entries`, both behind row-level security, so it must run inside a book-scoped
   * transaction like everything else here.
   */
  async lowestPrefixBalance(executor: Executor, accountId: string): Promise<LowestPrefix | null> {
    const result = await executor.execute<{ balance: string; occurred_at: Date }>(sql`
      select running::text as balance, occurred_at
      from (
        select
          sum(${postings.amountMinor}) over (
            order by ${entries.occurredAt}, ${postings.id}
            rows between unbounded preceding and current row
          ) as running,
          ${entries.occurredAt} as occurred_at
        from ${postings}
        join ${entries} on ${entries.id} = ${postings.entryId}
        where ${postings.accountId} = ${accountId}
      ) prefixes
      order by running asc, occurred_at asc
      limit 1
    `);

    const row = result.rows[0];
    if (row === undefined) return null;

    return { balanceMinor: BigInt(row.balance), occurredAt: new Date(row.occurred_at) };
  }
```

- [ ] **Step 5: Run the test again**

```bash
pnpm --filter @ledger/api exec vitest run --project integration tests/db/overdraft.prefix.test.ts
```

Expected: PASS, 4 tests.

If the `occurred_at` assertions fail with a timezone offset, the driver returned a `Date` already and `new Date(row.occurred_at)` is a no-op — compare with `.toISOString()` as the tests do rather than with string equality on the raw value.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/repositories/ledger.repository.ts apps/api/tests/db/overdraft.prefix.test.ts
git commit -m "feat(ledger): the lowest running balance of an account"
```

---

### Task 3: The naive rule in the service

This is step 1 of the stage's commit sequence: correct single-threaded, wrong under concurrency, and the next task is what proves it.

**Files:**
- Modify: `apps/api/src/services/ledger.service.ts`
- Test: `apps/api/tests/services/overdraft.test.ts`

**Interfaces:**
- Consumes: `isGuardedAccountType`, `AccountOverdrawnError` (Task 1); `lowestPrefixBalance` (Task 2).
- Produces: `postEntry` and `reverseEntry` reject entries that would leave a guarded account negative at any point. `assertPostable` now returns `Map<string, AccountRecord>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/services/overdraft.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { AccountOverdrawnError } from '../../src/domain/errors.js';
import type { LedgerService, PostEntryInput } from '../../src/services/ledger.service.js';
import { seedBookIn, type Book } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * The overdraft rule, single-threaded. Concurrency is `tests/concurrency/` - these are about
 * what the rule *means*, and the backdating cases are the ones that distinguish it from the
 * obvious "current balance must not be negative" reading.
 */

let pool: Pool;
let service: LedgerService;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 6 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

/** A fresh book, so each test's history is its own. */
async function freshBook(): Promise<Book> {
  return seedBookIn(pool);
}

/** Money into an account from revenue. Positive on the account. */
function deposit(book: Book, accountId: string, amount: string, occurredAt: string): PostEntryInput {
  return {
    occurredAt,
    description: `deposit ${amount}`,
    legs: [
      { accountId, amount, currency: 'EUR' },
      { accountId: book.sales, amount: `-${amount}`, currency: 'EUR' },
    ],
  };
}

/** Money out of an account into an expense. Negative on the account. */
function withdrawal(
  book: Book,
  accountId: string,
  amount: string,
  occurredAt: string,
): PostEntryInput {
  return {
    occurredAt,
    description: `withdrawal ${amount}`,
    legs: [
      { accountId, amount: `-${amount}`, currency: 'EUR' },
      { accountId: book.rent, amount, currency: 'EUR' },
    ],
  };
}

describe('an asset account may not go negative', () => {
  it('rejects a withdrawal larger than the balance', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-01-01T00:00:00.000Z'));

    await expect(
      service.postEntry(book.bookId, withdrawal(book, book.cash, '15.00', '2026-02-01T00:00:00.000Z')),
    ).rejects.toThrow(AccountOverdrawnError);
  });

  it('names the account, the shortfall and the moment', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-01-01T00:00:00.000Z'));

    const error = await service
      .postEntry(book.bookId, withdrawal(book, book.cash, '15.00', '2026-02-01T00:00:00.000Z'))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AccountOverdrawnError);
    const overdrawn = error as AccountOverdrawnError;
    expect(overdrawn.accountId).toBe(book.cash);
    expect(overdrawn.shortfall).toEqual({ currency: 'EUR', amountMinor: -500n });
    expect(overdrawn.occurredAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('accepts a withdrawal that lands exactly on zero', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-01-01T00:00:00.000Z'));

    const result = await service.postEntry(
      book.bookId,
      withdrawal(book, book.cash, '10.00', '2026-02-01T00:00:00.000Z'),
    );

    expect(result.created).toBe(true);
  });

  it('leaves unguarded types alone', async () => {
    const book = await freshBook();

    // Revenue going negative is ordinary: that is what a credit balance is.
    const result = await service.postEntry(book.bookId, {
      occurredAt: '2026-01-01T00:00:00.000Z',
      description: 'a sale',
      legs: [
        { accountId: book.cash, amount: '10.00', currency: 'EUR' },
        { accountId: book.sales, amount: '-10.00', currency: 'EUR' },
      ],
    });

    expect(result.created).toBe(true);
  });
});

describe('backdating', () => {
  it('rejects a backdated withdrawal that dips the history, even when today is positive', async () => {
    const book = await freshBook();

    // March: +10.00. April: +100.00. Today's balance is 110.00.
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-03-01T00:00:00.000Z'));
    await service.postEntry(book.bookId, deposit(book, book.cash, '100.00', '2026-04-01T00:00:00.000Z'));

    // A withdrawal of 50.00 dated between them. The final balance would be 60.00 - fine by
    // any current-balance rule - but on 15 March the account holds 10.00 and goes to -40.00.
    await expect(
      service.postEntry(book.bookId, withdrawal(book, book.cash, '50.00', '2026-03-15T00:00:00.000Z')),
    ).rejects.toThrow(AccountOverdrawnError);
  });

  it('accepts the same withdrawal once a backdated deposit covers it', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '10.00', '2026-03-01T00:00:00.000Z'));
    await service.postEntry(book.bookId, deposit(book, book.cash, '100.00', '2026-04-01T00:00:00.000Z'));

    await expect(
      service.postEntry(book.bookId, withdrawal(book, book.cash, '50.00', '2026-03-15T00:00:00.000Z')),
    ).rejects.toThrow(AccountOverdrawnError);

    // 2 March: the money was there all along, we just had not recorded it.
    await service.postEntry(book.bookId, deposit(book, book.cash, '60.00', '2026-03-02T00:00:00.000Z'));

    const result = await service.postEntry(
      book.bookId,
      withdrawal(book, book.cash, '50.00', '2026-03-15T00:00:00.000Z'),
    );

    expect(result.created).toBe(true);
  });
});

describe('within a single entry', () => {
  it('rejects an entry that dips between its own legs, even though it nets positive', async () => {
    const book = await freshBook();

    // -100.00 then +150.00 on cash: nets +50.00, and the prefix after the first leg is
    // -100.00. Per-leg, not per-net.
    await expect(
      service.postEntry(book.bookId, {
        occurredAt: '2026-01-01T00:00:00.000Z',
        description: 'net positive, momentarily negative',
        legs: [
          { accountId: book.cash, amount: '-100.00', currency: 'EUR' },
          { accountId: book.cash, amount: '150.00', currency: 'EUR' },
          { accountId: book.sales, amount: '-50.00', currency: 'EUR' },
        ],
      }),
    ).rejects.toThrow(AccountOverdrawnError);
  });
});

describe('reversals', () => {
  it('rejects a reversal that would overdraw the account', async () => {
    const book = await freshBook();

    const funded = await service.postEntry(
      book.bookId,
      deposit(book, book.cash, '100.00', '2026-01-01T00:00:00.000Z'),
    );
    await service.postEntry(book.bookId, withdrawal(book, book.cash, '80.00', '2026-02-01T00:00:00.000Z'));

    // Reversing the deposit takes 100.00 back out of an account holding 20.00.
    await expect(service.reverseEntry(book.bookId, funded.entry.id)).rejects.toThrow(
      AccountOverdrawnError,
    );
  });

  it('allows a reversal the balance can absorb', async () => {
    const book = await freshBook();
    await service.postEntry(book.bookId, deposit(book, book.cash, '100.00', '2026-01-01T00:00:00.000Z'));
    const spent = await service.postEntry(
      book.bookId,
      withdrawal(book, book.cash, '30.00', '2026-02-01T00:00:00.000Z'),
    );

    const reversal = await service.reverseEntry(book.bookId, spent.entry.id);

    expect(reversal.reversalOf).toBe(spent.entry.id);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api exec vitest run --project integration tests/services/overdraft.test.ts
```

Expected: FAIL — the rejection cases resolve instead of throwing, e.g. `promise resolved instead of rejecting`.

- [ ] **Step 3: Import what the check needs**

In `apps/api/src/services/ledger.service.ts`, add to the existing imports:

```ts
import {
  AccountClosedError,
  AccountNotFoundError,
  AccountNotInBookError,
  AccountOverdrawnError,
  BookNotFoundError,
  EntryAlreadyReversedError,
  EntryNotFoundError,
  CurrencyMismatchError,
  type CurrencyImbalance,
  UnbalancedEntryError,
  ValidationError,
} from '../domain/errors.js';
import { isGuardedAccountType } from '../domain/overdraft.js';
```

- [ ] **Step 4: Have `assertPostable` hand back the accounts it already fetched**

Still in `ledger.service.ts`, change its signature and its final line so the caller can reuse the map instead of asking again:

```ts
  private async assertPostable(
    tx: Executor,
    bookId: string,
    legs: readonly Leg[],
  ): Promise<Map<string, AccountRecord>> {
```

and, at the end of that method, after the `for` loop:

```ts
    return byId;
  }
```

- [ ] **Step 5: Add the check**

Add these two private methods to `LedgerService`, directly after `assertPostable`:

```ts
  /**
   * The overdraft rule: no guarded account may be negative at any point in its history.
   *
   * Run *after* the insert, deliberately. The new postings are then simply part of the
   * history the query examines, so there is no pending state to merge with committed state
   * and reversals need no separate code path. A violation throws and the transaction rolls
   * back, which is the same bargain the deferred zero-sum trigger makes.
   *
   * Only accounts carrying a *negative* leg are checked. If every leg on an account is
   * non-negative no prefix can fall: all legs of an entry share one `occurred_at`, and new
   * postings take ids above every existing row, so prefixes before the entry are untouched
   * and every prefix at or after it rises. Note that a positive *net* is not enough - an
   * entry with -100 and +150 on one account nets +50 and dips to -100 in between.
   *
   * This implementation is correct exactly as long as nothing else is writing. Stage 4's
   * whole point is that READ COMMITTED does not make that true; `evidence/overdraft-race`
   * has the proof and the row locks are what fix it.
   */
  private async assertNoOverdraft(
    tx: Executor,
    legs: readonly PostedLeg[],
    known: ReadonlyMap<string, AccountRecord>,
  ): Promise<void> {
    for (const accountId of guardedAccountsAtRisk(legs, known)) {
      const lowest = await this.repository.lowestPrefixBalance(tx, accountId);
      if (lowest === null || lowest.balanceMinor >= 0n) continue;

      const account = known.get(accountId);
      throw new AccountOverdrawnError(
        accountId,
        { currency: account?.currency ?? '', amountMinor: lowest.balanceMinor },
        lowest.occurredAt,
      );
    }
  }

  /**
   * The accounts an entry's legs refer to, as records. `postEntry` already has them from
   * `assertPostable`; `reverseEntry` does not, because its legs come from the original entry
   * rather than from user input that had to be validated.
   */
  private async accountsOfLegs(
    tx: Executor,
    legs: readonly PostedLeg[],
  ): Promise<Map<string, AccountRecord>> {
    const ids = [...new Set(legs.map((leg) => leg.accountId))];
    const found = await this.repository.findAccountsByIds(tx, ids);
    return new Map(found.map((account) => [account.id, account]));
  }
```

Add the leg shape and the selection helper at module scope, next to `assertBalanced` at the bottom of the file:

```ts
/** A leg as it is written: minor units, not `Money`. What both write paths have in common. */
interface PostedLeg {
  readonly accountId: string;
  readonly amountMinor: bigint;
}

/**
 * Which accounts this entry could possibly overdraw: guarded, and taking money out.
 *
 * Sorted, so the order accounts are checked - and, from the row-lock fix onwards, locked -
 * is a property of the data rather than of how the caller happened to order the legs. Two
 * concurrent entries touching the same pair of accounts in opposite order would otherwise
 * deadlock.
 */
function guardedAccountsAtRisk(
  legs: readonly PostedLeg[],
  known: ReadonlyMap<string, AccountRecord>,
): string[] {
  const atRisk = new Set<string>();

  for (const leg of legs) {
    if (leg.amountMinor >= 0n) continue;

    const account = known.get(leg.accountId);
    if (account !== undefined && isGuardedAccountType(account.type)) atRisk.add(account.id);
  }

  return [...atRisk].sort();
}
```

- [ ] **Step 6: Call it from `postEntry`**

In `postEntry`, replace the `await this.assertPostable(...)` line and the block that follows it:

```ts
        const accounts = await this.assertPostable(tx, bookId, legs);

        const postedLegs = legs.map((leg) => ({
          accountId: leg.accountId,
          amountMinor: leg.amount.amountMinor,
          currency: leg.amount.currency,
        }));

        const entry = await this.repository.insertEntry(tx, {
          id: entryId,
          bookId,
          occurredAt: parsed.occurredAt,
          recordedAt,
          description: parsed.description,
          externalId,
          createdByUserId: author.createdByUserId ?? null,
          createdByApiKeyId: author.createdByApiKeyId ?? null,
          legs: postedLegs,
        });

        await this.assertNoOverdraft(tx, postedLegs, accounts);

        return { entry, created: true };
```

- [ ] **Step 7: Call it from `reverseEntry`**

In `reverseEntry`, replace the `return this.repository.insertEntry(tx, { ... })` statement with:

```ts
      const legs = original.postings.map((posting) => ({
        accountId: posting.accountId,
        amountMinor: -posting.amountMinor,
        currency: posting.currency,
      }));

      const reversal = await this.repository.insertEntry(tx, {
        id: this.newId(),
        bookId,

        // When the correction happens, not when the original did. Backdating a reversal to
        // the original's date would make a balance that was correct as of last March silently
        // change, and "what did we believe on the 31st" would stop having an answer.
        occurredAt: parsed.occurredAt ?? recordedAt,
        recordedAt,
        description: parsed.description ?? `Reversal of: ${original.description}`,

        // Deliberately not inherited. `external_id` is unique per book, so copying the
        // original's would collide, and a reversal is a different event that deserves its own
        // idempotency key or none at all.
        externalId: parsed.externalId ?? null,

        reversalOf: entryId,
        createdByUserId: author.createdByUserId ?? null,
        createdByApiKeyId: author.createdByApiKeyId ?? null,

        legs,
      });

      // A reversal is not exempt. An entry that cannot be reversed without overdrawing an
      // account is one whose reversal alone is not the correction, and the error says how
      // much has to be deposited first.
      await this.assertNoOverdraft(tx, legs, await this.accountsOfLegs(tx, legs));

      return reversal;
```

- [ ] **Step 8: Run the new tests**

```bash
pnpm --filter @ledger/api exec vitest run --project integration tests/services/overdraft.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 9: Run the whole suite and the typechecker**

```bash
pnpm --filter @ledger/api test
```

Expected: PASS. `tests/services/ledger.service.test.ts` and `tests/http/ledger.test.ts` post entries into `cash` — every one of them is a deposit or is covered, so none should start failing. If one does, it is an entry that overdraws an asset account and the fixture needs funding first, not the rule loosening.

```bash
pnpm --filter @ledger/api typecheck
```

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/ledger.service.ts apps/api/tests/services/overdraft.test.ts
git commit -m "feat(ledger): the overdraft rule, checked in the service"
```

---

### Task 4: The concurrency test harness

No race yet — this task only builds the machinery and proves it works, so that the evidence commit in Task 5 is one file and one assertion.

**Files:**
- Modify: `apps/api/vitest.config.ts`
- Create: `apps/api/tests/helpers/concurrency.ts`
- Test: `apps/api/tests/concurrency/harness.test.ts`

**Interfaces:**
- Consumes: `createService` (existing helper), `seedBookIn` (existing helper).
- Produces: `fundedBook(pool, service, amount): Promise<Book>`, `transfersOf(...)`, and the `concurrency` vitest project including `tests/concurrency/**/*.test.ts`.

- [ ] **Step 1: Add the vitest project**

In `apps/api/vitest.config.ts`, add a third project after `integration`:

```ts
      {
        test: {
          name: 'concurrency',
          include: ['tests/concurrency/**/*.test.ts'],
          globalSetup: ['./tests/setup/postgres.global.ts'],

          testTimeout: 60_000,
          hookTimeout: 120_000,

          // Genuinely concurrent connections are the subject, so these cannot share the
          // single-worker discipline of the integration project: every test here opens its
          // own pool and fires overlapping transactions through it. One file at a time, so
          // two files are never contending for the same container's connection slots.
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
```

- [ ] **Step 2: Write the harness helper**

Create `apps/api/tests/helpers/concurrency.ts`:

```ts
import type { Pool } from 'pg';
import type { LedgerService, PostEntryInput } from '../../src/services/ledger.service.js';
import { seedBookIn, type Book } from './ledger.js';

/**
 * Fixtures for the concurrency tests.
 *
 * Everything here works in whole euros and fires real transactions through a real pool. A
 * fake would be worse than useless: the entire question is what two Postgres transactions do
 * to each other, and the answer is not a property of this process.
 */

/** A book whose `cash` account holds `amountMinor`, committed before anything races. */
export async function fundedBook(
  pool: Pool,
  service: LedgerService,
  amountMinor: bigint,
): Promise<Book> {
  const book = await seedBookIn(pool);

  await service.postEntry(book.bookId, {
    occurredAt: '2026-01-01T00:00:00.000Z',
    description: 'opening balance',
    legs: [
      { accountId: book.cash, amount: decimal(amountMinor), currency: 'EUR' },
      { accountId: book.sales, amount: decimal(-amountMinor), currency: 'EUR' },
    ],
  });

  return book;
}

/** One withdrawal from `cash`. Each is individually affordable; together they are not. */
export function withdrawal(book: Book, amountMinor: bigint, index: number): PostEntryInput {
  return {
    occurredAt: '2026-02-01T00:00:00.000Z',
    description: `concurrent withdrawal ${index.toString()}`,
    legs: [
      { accountId: book.cash, amount: decimal(-amountMinor), currency: 'EUR' },
      { accountId: book.rent, amount: decimal(amountMinor), currency: 'EUR' },
    ],
  };
}

/**
 * Fires `count` withdrawals at once and reports how each ended.
 *
 * Rejections are expected and are not failures: the rule is supposed to refuse some of them.
 * What the caller asserts on is the balance afterwards.
 */
export async function fireConcurrently(
  service: LedgerService,
  book: Book,
  count: number,
  amountMinor: bigint,
): Promise<{ accepted: number; rejected: number; errors: unknown[] }> {
  const attempts = Array.from({ length: count }, (_, index) =>
    service.postEntry(book.bookId, withdrawal(book, amountMinor, index)),
  );

  const settled = await Promise.allSettled(attempts);

  return {
    accepted: settled.filter((result) => result.status === 'fulfilled').length,
    rejected: settled.filter((result) => result.status === 'rejected').length,
    errors: settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
  };
}

/** Minor units as the decimal string the service's input schema expects. €12.34 from 1234n. */
function decimal(amountMinor: bigint): string {
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  const units = absolute / 100n;
  const cents = absolute % 100n;

  return `${negative ? '-' : ''}${units.toString()}.${cents.toString().padStart(2, '0')}`;
}
```

- [ ] **Step 3: Write the harness test**

Create `apps/api/tests/concurrency/harness.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { fundedBook } from '../helpers/concurrency.js';
import { balanceOf } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

let pool: Pool;
let service: LedgerService;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 20 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

describe('the concurrency harness', () => {
  it('funds a book to a known balance', async () => {
    const book = await fundedBook(pool, service, 50_000n);

    expect(await balanceOf(pool, book.bookId, book.cash)).toBe(50_000n);
  });
});
```

- [ ] **Step 4: Run it**

```bash
pnpm --filter @ledger/api exec vitest run --project concurrency
```

Expected: PASS, 1 test.

- [ ] **Step 5: Confirm the other projects still run**

```bash
pnpm --filter @ledger/api test
```

Expected: PASS across `unit`, `integration` and `concurrency`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/vitest.config.ts apps/api/tests/helpers/concurrency.ts apps/api/tests/concurrency/harness.test.ts
git commit -m "test: a vitest project for genuinely concurrent transactions"
```

---

### Task 5: The evidence

This task's deliverable is a **red** commit on a branch that is never merged. `stage-4-concurrency-and-overdraft` is not modified.

**Files:**
- Create (on `evidence/overdraft-race` only): `apps/api/tests/concurrency/overdraft.race.test.ts`

**Interfaces:**
- Consumes: `fundedBook`, `fireConcurrently` (Task 4); the naive rule (Task 3).
- Produces: nothing later tasks import. Task 7 writes the same file again on the main branch.

- [ ] **Step 1: Branch**

```bash
git checkout -b evidence/overdraft-race
```

- [ ] **Step 2: Write the test that should pass and does not**

Create `apps/api/tests/concurrency/overdraft.race.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { fireConcurrently, fundedBook } from '../helpers/concurrency.js';
import { balanceOf } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * EVIDENCE. This test fails, and that is the point of the commit it lands in.
 *
 * The overdraft rule is implemented the obvious way: read the balance, check it, insert.
 * Every one of the withdrawals below is individually affordable, and the check passes for
 * every one of them - because under READ COMMITTED each transaction reads a snapshot taken
 * before any of the others committed. They then all insert, and the account ends up
 * overdrawn by an amount no single request ever asked for.
 *
 * The rule is not wrong. The isolation level is not strong enough to enforce it, and no
 * amount of care in the service can change that: a check and the write it authorises are two
 * statements, and nothing here makes them one decision.
 *
 * Reproduced across several rounds because a race is a probability, not a certainty. One
 * negative balance in any round is a failure - and one is all the claim needs.
 */

const ROUNDS = 5;
/** €500.00 available, sixteen concurrent requests for €100.00. At most five may succeed. */
const OPENING = 50_000n;
const WITHDRAWAL = 10_000n;
const CONCURRENT = 16;

let pool: Pool;
let service: LedgerService;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 20 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

describe('concurrent withdrawals', () => {
  it('never drives a guarded account negative', async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const book = await fundedBook(pool, service, OPENING);

      await fireConcurrently(service, book, CONCURRENT, WITHDRAWAL);

      const balance = await balanceOf(pool, book.bookId, book.cash);

      expect(balance, `round ${round.toString()} left the account overdrawn`).toBeGreaterThanOrEqual(
        0n,
      );
    }
  });

  it('conserves total value regardless of who wins', async () => {
    const book = await fundedBook(pool, service, OPENING);

    await fireConcurrently(service, book, CONCURRENT, WITHDRAWAL);

    const cash = await balanceOf(pool, book.bookId, book.cash);
    const rent = await balanceOf(pool, book.bookId, book.rent);
    const sales = await balanceOf(pool, book.bookId, book.sales);

    expect(cash + rent + sales).toBe(0n);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
pnpm --filter @ledger/api exec vitest run --project concurrency tests/concurrency/overdraft.race.test.ts
```

Expected: FAIL on `never drives a guarded account negative`, with a message naming the round and a negative balance such as `expected -30000n to be greater than or equal to 0n`.

`conserves total value` should PASS — the zero-sum invariant is enforced by the database and is not what breaks here. That contrast is the useful part: the entries are all individually valid, and the rule that failed is the one only the application was defending.

If all five rounds pass, the machine is winning the race too easily. Raise `CONCURRENT` to 32 and `ROUNDS` to 10 and run again. Do not add a sleep between the check and the insert — a race that has to be helped is not evidence.

- [ ] **Step 4: Commit the failure**

```bash
git add apps/api/tests/concurrency/overdraft.race.test.ts
git commit -m "test: evidence that READ COMMITTED does not enforce the overdraft rule

Sixteen concurrent withdrawals, each individually affordable, against an
account holding five of them. Every check passes because every
transaction reads a snapshot taken before any of the others committed,
and the account ends up overdrawn by an amount no request asked for.

This commit is red on purpose and is not merged. It is the artifact the
ADR points at."
```

- [ ] **Step 5: Publish it and go back**

```bash
git push -u origin evidence/overdraft-race
git checkout stage-4-concurrency-and-overdraft
```

Confirm the main branch is clean and green:

```bash
git status --short
```

Expected: no output.

---

### Task 6: The database enforces it too

**Files:**
- Create: `apps/api/drizzle/0007_overdraft.sql`
- Modify: `apps/api/drizzle/meta/_journal.json`
- Modify: `apps/api/src/db/pg-errors.ts`
- Modify: `apps/api/src/services/ledger.service.ts`
- Test: `apps/api/tests/db/overdraft.trigger.test.ts`

**Interfaces:**
- Consumes: `GUARDED_ACCOUNT_TYPES` (Task 1), `AccountOverdrawnError` (Task 1).
- Produces: SQLSTATE `LG004`, the SQL function `guarded_account_types()`, and `SQLSTATE.ACCOUNT_OVERDRAWN`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/db/overdraft.trigger.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { GUARDED_ACCOUNT_TYPES } from '../../src/domain/overdraft.js';
import { insertEntry, queryInBook, seedBook, withClient } from '../helpers/ledger.js';

/**
 * The overdraft rule as the database sees it.
 *
 * These insert straight through SQL, so nothing in `ledger.service.ts` is involved. That is
 * the whole question: an invariant only the application enforces is an invariant that a
 * migration script, a psql session or a future bug can walk straight past.
 */

/** Ledger: a guarded account would be left negative. Raised at COMMIT. */
const ACCOUNT_OVERDRAWN = 'LG004';

let appPool: Pool;

beforeAll(() => {
  appPool = new Pool({ connectionString: inject('appUrl'), max: 4 });
});

afterAll(async () => {
  await appPool.end();
});

describe('guarded_account_types()', () => {
  it('agrees with the application', async () => {
    const book = await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const seeded = await seedBook(client);
      await client.query('COMMIT');
      return seeded;
    });

    const rows = await queryInBook<{ types: string[] }>(
      appPool,
      book.bookId,
      'SELECT guarded_account_types()::text[] AS types',
    );

    expect(rows[0]?.types).toEqual([...GUARDED_ACCOUNT_TYPES]);
  });
});

describe('LG004, deferred to COMMIT', () => {
  it('rejects an entry that leaves an asset account negative', async () => {
    await expect(
      withClient(appPool, async (client) => {
        await client.query('BEGIN');
        const book = await seedBook(client);

        // Straight to -5.00 with no opening balance at all.
        await insertEntry(client, book, [
          { accountId: book.cash, amountMinor: -500n },
          { accountId: book.rent, amountMinor: 500n },
        ]);

        await client.query('COMMIT');
      }),
    ).rejects.toMatchObject({ code: ACCOUNT_OVERDRAWN });
  });

  it('leaves unguarded types alone', async () => {
    await withClient(appPool, async (client) => {
      await client.query('BEGIN');
      const book = await seedBook(client);

      // Revenue at -10.00 is an ordinary credit balance.
      await insertEntry(client, book, [
        { accountId: book.cash, amountMinor: 1000n },
        { accountId: book.sales, amountMinor: -1000n },
      ]);

      await client.query('COMMIT');
    });
  });

  it('rejects a backdated withdrawal that dips a historical prefix', async () => {
    await expect(
      withClient(appPool, async (client) => {
        await client.query('BEGIN');
        const book = await seedBook(client);

        const opening = await insertEntry(client, book, [
          { accountId: book.cash, amountMinor: 1000n },
          { accountId: book.sales, amountMinor: -1000n },
        ]);
        await client.query('UPDATE entries SET occurred_at = $1 WHERE id = $2', [
          '2026-03-01T00:00:00.000Z',
          opening,
        ]);

        const later = await insertEntry(client, book, [
          { accountId: book.cash, amountMinor: 10_000n },
          { accountId: book.sales, amountMinor: -10_000n },
        ]);
        await client.query('UPDATE entries SET occurred_at = $1 WHERE id = $2', [
          '2026-04-01T00:00:00.000Z',
          later,
        ]);

        await client.query('COMMIT');
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_book_id', $1, true)", [book.bookId]);

        // Ends at +60.00, but on 15 March the account holds 10.00 and this takes 50.00.
        const backdated = await insertEntry(client, book, [
          { accountId: book.cash, amountMinor: -5000n },
          { accountId: book.rent, amountMinor: 5000n },
        ]);
        await client.query('UPDATE entries SET occurred_at = $1 WHERE id = $2', [
          '2026-03-15T00:00:00.000Z',
          backdated,
        ]);

        await client.query('COMMIT');
      }),
    ).rejects.toMatchObject({ code: ACCOUNT_OVERDRAWN });
  });
});
```

Note: the `UPDATE entries SET occurred_at` statements run before the entry is committed, so the append-only trigger from migration 0003 permits them — it fires on `UPDATE`, and an uncommitted row is still a row. If `LG002` is raised, insert the entries with the desired `occurred_at` instead by extending `insertEntry` in `tests/helpers/ledger.ts` with an `occurredAt` option rather than fighting the trigger.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api exec vitest run --project integration tests/db/overdraft.trigger.test.ts
```

Expected: FAIL — `function guarded_account_types() does not exist`, and the two rejection cases commit successfully instead of raising.

- [ ] **Step 3: Write the migration**

Create `apps/api/drizzle/0007_overdraft.sql`:

```sql
-- The overdraft rule, enforced in the database.
--
--   LG004  a guarded account would be left negative at some point in its history


-- ---------------------------------------------------------------------------------------
-- Which account types may not go negative.
--
-- A function rather than a literal inside the trigger, so that the duplication between here
-- and `domain/overdraft.ts` is something a test can compare rather than something a reader
-- has to notice. `tests/db/overdraft.trigger.test.ts` asserts the two lists are equal.
--
-- IMMUTABLE because the answer is fixed by accounting, not by data: an asset account is the
-- one that holds a thing, and a thing cannot be held in negative quantity.
CREATE FUNCTION guarded_account_types() RETURNS public.account_type[]
	LANGUAGE sql
	IMMUTABLE
	PARALLEL SAFE
	SET search_path = pg_catalog, public
	AS $$ SELECT ARRAY['asset']::public.account_type[] $$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION guarded_account_types() TO ledger_app;--> statement-breakpoint


-- ---------------------------------------------------------------------------------------
-- LG004 - a guarded account's balance is never negative, at any point in its history.
--
-- "At any point" and not "at the end", because `occurred_at` is asserted by the caller and
-- an entry recorded today can land in the past. A rule about the current balance alone would
-- accept a backdated withdrawal that overdrew the account on the very date it describes.
--
-- Ordered by (occurred_at, id). The tiebreaker is not decoration: two legs of one entry
-- always share an occurred_at, so without it the window has no defined order among them and
-- the minimum is whatever the plan happened to produce. `postings.id` is a bigserial, so it
-- is a total order consistent with the sequence rows were recorded in.
--
-- A CONSTRAINT TRIGGER for the same two reasons as LG001: the invariant is a property of a
-- set of rows rather than of one, and it is legitimately false partway through the
-- transaction that establishes it - an entry's negative leg may be inserted before the
-- positive one that funds it.
--
-- SECURITY DEFINER for the same reason too. `postings` is behind row-level security, and a
-- SECURITY INVOKER function would sum only the rows the current role can see, so an account
-- could pass here while being overdrawn in fact.
--
-- What this does NOT do is make the rule safe under concurrency. The query runs at COMMIT
-- and, under READ COMMITTED, takes a fresh snapshot - so it sees transactions committed
-- since the statement that fired it, and the window in which two writers can both pass is
-- narrow. Narrow is not closed: two transactions committing at once can each check before
-- the other commits. See docs/adr/0004-concurrency-control.md; the row locks in the service
-- are what actually settles it.
CREATE FUNCTION assert_account_not_overdrawn() RETURNS trigger
	LANGUAGE plpgsql
	SECURITY DEFINER
	SET search_path = pg_catalog, public
	AS $$
DECLARE
	lowest bigint;
	dipped_at timestamptz;
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM public.accounts a
		WHERE a.id = NEW.account_id
		  AND a.type = ANY (public.guarded_account_types())
	) THEN
		RETURN NULL;
	END IF;

	SELECT prefixes.running, prefixes.occurred_at
		INTO lowest, dipped_at
	FROM (
		SELECT
			sum(p.amount_minor) OVER (
				ORDER BY e.occurred_at, p.id
				ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			) AS running,
			e.occurred_at AS occurred_at
		FROM public.postings p
		JOIN public.entries e ON e.id = p.entry_id
		WHERE p.account_id = NEW.account_id
	) prefixes
	ORDER BY prefixes.running ASC, prefixes.occurred_at ASC
	LIMIT 1;

	IF lowest < 0 THEN
		RAISE EXCEPTION 'account % would be overdrawn: its balance reaches % at %', NEW.account_id, lowest, dipped_at
			USING ERRCODE = 'LG004',
			      HINT = 'A guarded account may not hold a negative balance at any point in its history.';
	END IF;

	RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER postings_account_not_overdrawn
	AFTER INSERT ON postings
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION assert_account_not_overdrawn();
```

- [ ] **Step 4: Register the migration**

In `apps/api/drizzle/meta/_journal.json`, append to `entries` (keeping the existing entries unchanged):

```json
    {
      "idx": 7,
      "version": "7",
      "when": 1785500000000,
      "tag": "0007_overdraft",
      "breakpoints": true
    }
```

- [ ] **Step 5: Add the SQLSTATE**

In `apps/api/src/db/pg-errors.ts`, add to the `SQLSTATE` object:

```ts
  /** Ledger: a guarded account would be left negative. Raised at COMMIT. */
  ACCOUNT_OVERDRAWN: 'LG004',
```

- [ ] **Step 6: Translate it in the service**

In `postEntry`'s `catch` block in `apps/api/src/services/ledger.service.ts`, after the `ENTRY_UNBALANCED` translation:

```ts
      // The application check above should have caught this too. When the database raises it
      // anyway, two writers raced and one of them lost at COMMIT - which is the failure mode
      // this stage exists to characterise, and which the row locks below remove. Either way
      // the entry is rejected, and the caller gets the same error class as the fast path.
      if (hasSqlState(error, SQLSTATE.ACCOUNT_OVERDRAWN)) {
        throw new AccountOverdrawnError('', null, null, { cause: error });
      }
```

`reverseEntry` has no `try/catch`; wrap its body the same way is **not** required for this task — the ADR case for it is made once the concurrency strategies exist. Leave it.

- [ ] **Step 7: Run the trigger tests**

```bash
pnpm --filter @ledger/api exec vitest run --project integration tests/db/overdraft.trigger.test.ts
```

Expected: PASS, 4 tests. The container is migrated fresh by the global setup, so `0007` is applied automatically.

- [ ] **Step 8: Run everything**

```bash
pnpm --filter @ledger/api test
```

Expected: PASS on all three projects. `tests/concurrency/harness.test.ts` still passes; the race test is not on this branch.

- [ ] **Step 9: Commit**

```bash
git add apps/api/drizzle/0007_overdraft.sql apps/api/drizzle/meta/_journal.json apps/api/src/db/pg-errors.ts apps/api/src/services/ledger.service.ts apps/api/tests/db/overdraft.trigger.test.ts
git commit -m "feat(db): LG004, the overdraft rule as a deferred constraint trigger

Binds every writer, not just the service. It also narrows the race
without closing it: the trigger's query runs at COMMIT and, under READ
COMMITTED, takes a fresh snapshot, so two transactions committing at
once can still each pass before the other lands."
```

---

### Task 7: The row-lock fix

**Files:**
- Modify: `apps/api/src/repositories/ledger.repository.ts`
- Modify: `apps/api/src/services/ledger.service.ts`
- Create: `apps/api/tests/concurrency/overdraft.race.test.ts`
- Create: `apps/api/tests/concurrency/deadlock.test.ts`

**Interfaces:**
- Consumes: `guardedAccountsAtRisk` (Task 3), `fireConcurrently`/`fundedBook` (Task 4).
- Produces: `LedgerRepository.lockAccounts(executor, accountIds): Promise<void>`.

- [ ] **Step 1: Bring the race test onto this branch**

Create `apps/api/tests/concurrency/overdraft.race.test.ts` with **exactly the file from Task 5, Step 2**, changing only the header comment to:

```ts
/**
 * The race the row locks close.
 *
 * `evidence/overdraft-race` has this same test against the naive implementation, where it
 * fails: sixteen individually affordable withdrawals all pass their check against a snapshot
 * taken before any of them committed, and the account ends up overdrawn by an amount no
 * single request ever asked for.
 *
 * What changed is not the rule but who decides. `SELECT ... FOR UPDATE` on the account row
 * makes the check and the insert one decision per account instead of two statements with a
 * window between them.
 */
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api exec vitest run --project concurrency tests/concurrency/overdraft.race.test.ts
```

Expected: FAIL on `never drives a guarded account negative`.

It may now fail on a later round than it did in Task 5, because the trigger from Task 6 catches most of the racing transactions at COMMIT. If it passes all five rounds, raise `ROUNDS` to 10 — and note the round it first fails on, because that number is a data point the ADR uses.

- [ ] **Step 3: Add the lock to the repository**

In `apps/api/src/repositories/ledger.repository.ts`, add to the `LedgerRepository` interface after `lowestPrefixBalance`:

```ts
  /**
   * Takes a row lock on each account, in ascending id order. Blocks until any transaction
   * holding one commits or rolls back.
   */
  lockAccounts(executor: Executor, accountIds: readonly string[]): Promise<void>;
```

And the implementation, after `lowestPrefixBalance`:

```ts
  /**
   * Row locks on the accounts an entry could overdraw.
   *
   * The lock is on `accounts`, not on `postings`, and that is the point: the rows being
   * inserted do not exist yet, so there is nothing there to lock. The account row is a
   * pre-existing thing every writer to that account has to go through, which turns "check
   * then insert" into a decision only one transaction can be making at a time.
   *
   * `ORDER BY id` prevents deadlock. Two entries touching the same two accounts in opposite
   * leg order would otherwise take the locks in opposite orders and wait on each other
   * forever. Postgres plans `LockRows` above `Sort`, so a single statement with ORDER BY
   * acquires in sorted order; `tests/concurrency/deadlock.test.ts` is what holds that claim
   * up rather than trusting it.
   *
   * Nothing is returned. The rows are already known to the caller - this statement exists
   * for its side effect, which is the honest description of a lock.
   */
  async lockAccounts(executor: Executor, accountIds: readonly string[]): Promise<void> {
    if (accountIds.length === 0) return;

    await executor.execute(
      sql`select id from ${accounts} where ${accounts.id} = any(${[...accountIds]}) order by id for update`,
    );
  }
```

- [ ] **Step 4: Take the lock before inserting**

In `apps/api/src/services/ledger.service.ts`, add this private method directly above `assertNoOverdraft`:

```ts
  /**
   * Locks every guarded account this entry could overdraw, before anything is written.
   *
   * Before, not after: a lock taken after the insert would still leave the read that decides
   * the entry's fate outside any mutual exclusion, which is the whole bug. Only the accounts
   * carrying a negative leg are locked, and that is sufficient - two transactions can only
   * jointly overdraw an account if both take money out of it, and both of those arrive here.
   * A concurrent *positive* posting is unlocked and unseen, which is conservative rather than
   * wrong: adding a positive posting at time T raises the prefixes at or after T and lowers
   * none.
   */
  private async lockAccountsAtRisk(
    tx: Executor,
    legs: readonly PostedLeg[],
    known: ReadonlyMap<string, AccountRecord>,
  ): Promise<void> {
    await this.repository.lockAccounts(tx, guardedAccountsAtRisk(legs, known));
  }
```

In `postEntry`, insert the lock between `assertPostable` and `insertEntry`:

```ts
        const accounts = await this.assertPostable(tx, bookId, legs);

        const postedLegs = legs.map((leg) => ({
          accountId: leg.accountId,
          amountMinor: leg.amount.amountMinor,
          currency: leg.amount.currency,
        }));

        await this.lockAccountsAtRisk(tx, postedLegs, accounts);

        const entry = await this.repository.insertEntry(tx, {
```

In `reverseEntry`, the accounts have to be fetched before the insert now. Replace the `const legs = ...` block through the `insertEntry` call with:

```ts
      const legs = original.postings.map((posting) => ({
        accountId: posting.accountId,
        amountMinor: -posting.amountMinor,
        currency: posting.currency,
      }));

      const accounts = await this.accountsOfLegs(tx, legs);
      await this.lockAccountsAtRisk(tx, legs, accounts);

      const reversal = await this.repository.insertEntry(tx, {
```

and change the check at the end of `reverseEntry` to reuse the map:

```ts
      await this.assertNoOverdraft(tx, legs, accounts);

      return reversal;
```

- [ ] **Step 5: Run the race test**

```bash
pnpm --filter @ledger/api exec vitest run --project concurrency tests/concurrency/overdraft.race.test.ts
```

Expected: PASS, 2 tests, all five rounds.

- [ ] **Step 6: Write the deadlock test**

Create `apps/api/tests/concurrency/deadlock.test.ts`:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LedgerService, PostEntryInput } from '../../src/services/ledger.service.js';
import { balanceOf, seedBookIn, type Book } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

/**
 * Two entries, two guarded accounts, opposite leg order.
 *
 * This is the failure the `ORDER BY id` in `lockAccounts` exists to prevent. Without it the
 * lock order follows the order the legs happened to arrive in, so one transaction holds cash
 * and wants bank while the other holds bank and wants cash, and Postgres breaks the tie by
 * killing one of them with a 40P01. With it, both take cash first and one simply waits.
 *
 * A deadlock here would surface as a rejection carrying SQLSTATE 40P01, which is why the
 * assertion is about the error codes and not only about the balances.
 */

let pool: Pool;
let service: LedgerService;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 10 });
  service = createService(pool).service;
});

afterAll(async () => {
  await pool.end();
});

/** Takes money out of both guarded accounts at once, in the given order. */
function drain(book: Book, first: string, second: string): PostEntryInput {
  return {
    occurredAt: '2026-02-01T00:00:00.000Z',
    description: 'draining two accounts',
    legs: [
      { accountId: first, amount: '-1.00', currency: 'EUR' },
      { accountId: second, amount: '-1.00', currency: 'EUR' },
      { accountId: book.rent, amount: '2.00', currency: 'EUR' },
    ],
  };
}

describe('two entries locking the same pair of accounts', () => {
  it('does not deadlock when the legs arrive in opposite orders', async () => {
    const book = await seedBookIn(pool);

    // Fund both guarded accounts so the overdraft rule is not what rejects anything.
    await service.postEntry(book.bookId, {
      occurredAt: '2026-01-01T00:00:00.000Z',
      description: 'opening balances',
      legs: [
        { accountId: book.cash, amount: '100.00', currency: 'EUR' },
        { accountId: book.bank, amount: '100.00', currency: 'EUR' },
        { accountId: book.sales, amount: '-200.00', currency: 'EUR' },
      ],
    });

    const settled = await Promise.allSettled([
      service.postEntry(book.bookId, drain(book, book.cash, book.bank)),
      service.postEntry(book.bookId, drain(book, book.bank, book.cash)),
    ]);

    const codes = settled.flatMap((result) =>
      result.status === 'rejected' ? [(result.reason as { code?: string }).code] : [],
    );

    // 40P01 is deadlock_detected. Nothing here should produce one.
    expect(codes).not.toContain('40P01');
    expect(settled.every((result) => result.status === 'fulfilled')).toBe(true);

    expect(await balanceOf(pool, book.bookId, book.cash)).toBe(9800n);
    expect(await balanceOf(pool, book.bookId, book.bank)).toBe(9800n);
  });
});
```

- [ ] **Step 7: Run it**

```bash
pnpm --filter @ledger/api exec vitest run --project concurrency
```

Expected: PASS, 4 tests across three files.

- [ ] **Step 8: Run everything**

```bash
pnpm --filter @ledger/api test
pnpm --filter @ledger/api typecheck
```

Expected: PASS, exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/repositories/ledger.repository.ts apps/api/src/services/ledger.service.ts apps/api/tests/concurrency/overdraft.race.test.ts apps/api/tests/concurrency/deadlock.test.ts
git commit -m "fix(ledger): row locks make the overdraft check and the insert one decision

SELECT ... FOR UPDATE on the guarded accounts an entry takes money out
of, acquired in ascending id order so two entries touching the same pair
in opposite leg order cannot deadlock. The race test from
evidence/overdraft-race now passes."
```

---

### Task 8: The `SERIALIZABLE` alternative

Built and tested for the comparison, not shipped. The default stays `row-lock`.

**Files:**
- Modify: `apps/api/src/db/client.ts`
- Modify: `apps/api/src/db/pg-errors.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/composition.ts`
- Modify: `apps/api/src/services/ledger.service.ts`
- Modify: `apps/api/tests/helpers/service.ts`
- Modify: `apps/api/tests/concurrency/overdraft.race.test.ts`
- Test: `apps/api/tests/unit/config.test.ts`

**Interfaces:**
- Consumes: `lockAccountsAtRisk` (Task 7).
- Produces: `ConcurrencyStrategy = 'row-lock' | 'serializable'`, `UnitOfWork.strategy`, `UnitOfWorkOptions { strategy, maxAttempts, onRetry }`, `Config.concurrency.strategy`, and `createService(pool, options)`.

- [ ] **Step 1: Write the failing config test**

Append to `apps/api/tests/unit/config.test.ts`:

```ts
describe('LEDGER_CONCURRENCY_STRATEGY', () => {
  it('defaults to row locks', () => {
    expect(loadConfig(validEnv()).concurrency.strategy).toBe('row-lock');
  });

  it('accepts serializable', () => {
    expect(
      loadConfig({ ...validEnv(), LEDGER_CONCURRENCY_STRATEGY: 'serializable' }).concurrency
        .strategy,
    ).toBe('serializable');
  });

  it('rejects anything else', () => {
    expect(() => loadConfig({ ...validEnv(), LEDGER_CONCURRENCY_STRATEGY: 'yolo' })).toThrow(
      ConfigError,
    );
  });
});
```

Use whatever the file already calls its valid-environment factory; if it builds the object inline, extract it into a `validEnv()` helper first and leave the existing tests calling it.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api exec vitest run --project unit tests/unit/config.test.ts
```

Expected: FAIL — `Property 'concurrency' does not exist`.

- [ ] **Step 3: Add the config**

In `apps/api/src/config.ts`, add to `envSchema`'s object, after `DATABASE_POOL_MAX`:

```ts
    /**
     * How the overdraft rule is made safe under concurrency. Row locks by default; see
     * docs/adr/0004-concurrency-control.md for why, and for what the other one costs.
     */
    LEDGER_CONCURRENCY_STRATEGY: z.enum(['row-lock', 'serializable']).default('row-lock'),
```

Add the interface and the `Config` member:

```ts
export interface ConcurrencyConfig {
  readonly strategy: 'row-lock' | 'serializable';
}
```

```ts
export interface Config {
  readonly nodeEnv: z.infer<typeof nodeEnv>;
  readonly isProduction: boolean;
  readonly port: number;
  readonly logLevel: z.infer<typeof logLevel>;
  readonly database: DatabaseConfig;
  readonly concurrency: ConcurrencyConfig;
  readonly auth: AuthConfig;
  readonly apiKeyEnvironment: ApiKeyEnvironment;
}
```

And in `loadConfig`'s returned object, after `database`:

```ts
    concurrency: Object.freeze({ strategy: env.LEDGER_CONCURRENCY_STRATEGY }),
```

- [ ] **Step 4: Add the serialization-failure SQLSTATE**

In `apps/api/src/db/pg-errors.ts`, add to `SQLSTATE`:

```ts
  /** Postgres: could not serialize access. The retryable one. */
  SERIALIZATION_FAILURE: '40001',
  /** Postgres: deadlock detected. Deliberately NOT retried - see lockAccounts. */
  DEADLOCK_DETECTED: '40P01',
```

- [ ] **Step 5: Teach the unit of work both strategies**

Rewrite `DrizzleUnitOfWork` in `apps/api/src/db/client.ts`, and extend the `UnitOfWork` interface with the strategy:

```ts
/**
 * How the overdraft rule is kept true when two writers meet.
 *
 * `row-lock`: the service takes `SELECT ... FOR UPDATE` on the accounts at risk and this
 * wrapper does nothing special. Writers block.
 *
 * `serializable`: no explicit locks; Postgres detects the conflict and aborts one of the
 * transactions with 40001, which this wrapper retries. Writers abort and try again.
 *
 * Both are correct. They are different bets about which is cheaper, and the ADR has numbers.
 */
export type ConcurrencyStrategy = 'row-lock' | 'serializable';

export interface UnitOfWorkOptions {
  readonly strategy?: ConcurrencyStrategy;
  /** Total attempts, not retries. Exceeding it rethrows the last 40001. */
  readonly maxAttempts?: number;
  /** Called before each retry. Exists so a test can assert the retry path actually ran. */
  readonly onRetry?: (attempt: number, error: unknown) => void;
}
```

Add to the `UnitOfWork` interface:

```ts
  /** Which concurrency strategy is in force. The service skips its row locks under `serializable`. */
  readonly strategy: ConcurrencyStrategy;
```

And the class:

```ts
export class DrizzleUnitOfWork implements UnitOfWork {
  readonly strategy: ConcurrencyStrategy;
  private readonly maxAttempts: number;
  private readonly onRetry: ((attempt: number, error: unknown) => void) | undefined;

  constructor(
    private readonly db: Database,
    options: UnitOfWorkOptions = {},
  ) {
    this.strategy = options.strategy ?? 'row-lock';
    this.maxAttempts = options.maxAttempts ?? 5;
    this.onRetry = options.onRetry;
  }

  get executor(): Executor {
    return this.db;
  }

  /**
   * READ COMMITTED by default, which is the Postgres default and is deliberately not
   * overridden: stage 4 demonstrated that it cannot enforce the overdraft rule on its own,
   * and then fixed that with locks rather than by raising the isolation level everywhere.
   * Under the `serializable` strategy this becomes SERIALIZABLE and 40001 is retried.
   */
  async transaction<T>(work: (tx: Executor) => Promise<T>): Promise<T> {
    return this.withRetry(() => this.db.transaction(async (tx) => work(tx), this.options()));
  }

  /**
   * `SET LOCAL` accepts no bind parameter - it is not a statement Postgres will plan with
   * one - so this is `set_config(..., is_local => true)`, which is the same thing and takes
   * the book id as a parameter instead of concatenating it into SQL text.
   *
   * Transaction-local, hence `is_local => true`. A session-level setting on a pooled
   * connection would outlive the request that set it and still be in place for whichever
   * request borrowed the connection next, which is a cross-book data leak whose cause looks
   * entirely innocent at the call site.
   *
   * The whole body is what gets retried, `set_config` included: a retry is a fresh
   * transaction, and a fresh transaction has no book context until it sets one.
   */
  async transactionInBook<T>(bookId: string, work: (tx: Executor) => Promise<T>): Promise<T> {
    return this.withRetry(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.current_book_id', ${bookId}, true)`);
        return work(tx);
      }, this.options()),
    );
  }

  private options(): { isolationLevel?: 'serializable' } {
    return this.strategy === 'serializable' ? { isolationLevel: 'serializable' } : {};
  }

  /**
   * Retries a transaction that Postgres refused to serialize.
   *
   * Only 40001, and only under the serializable strategy. Not 40P01: a deadlock means two
   * transactions took locks in incompatible orders, which is a bug in the lock ordering
   * rather than bad luck, and retrying it would hide the bug behind a slow success.
   *
   * The caller's `work` runs again from the top, so anything it must not repeat has to be
   * computed outside it. `postEntry` does exactly that with the entry id and `recordedAt`:
   * a retried post is the same entry, not a new one.
   */
  private async withRetry<T>(run: () => Promise<T>): Promise<T> {
    if (this.strategy !== 'serializable') return run();

    let last: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (!hasSqlState(error, SQLSTATE.SERIALIZATION_FAILURE)) throw error;

        last = error;
        this.onRetry?.(attempt, error);
      }
    }

    throw last;
  }
}
```

Add the import at the top of the file:

```ts
import { SQLSTATE, hasSqlState } from './pg-errors.js';
```

- [ ] **Step 6: Skip the locks under `serializable`**

In `apps/api/src/services/ledger.service.ts`, change `lockAccountsAtRisk` to consult the strategy:

```ts
  private async lockAccountsAtRisk(
    tx: Executor,
    legs: readonly PostedLeg[],
    known: ReadonlyMap<string, AccountRecord>,
  ): Promise<void> {
    // Under SERIALIZABLE the database is already tracking the conflict, and an explicit lock
    // would serialise writers that SSI would have let through - paying for both mechanisms
    // and getting the worse half of each.
    if (this.unitOfWork.strategy === 'serializable') return;

    await this.repository.lockAccounts(tx, guardedAccountsAtRisk(legs, known));
  }
```

- [ ] **Step 7: Wire it into the composition root**

In `apps/api/src/composition.ts`:

```ts
  const unitOfWork = new DrizzleUnitOfWork(db, { strategy: config.concurrency.strategy });
```

- [ ] **Step 8: Let the test harness choose a strategy**

In `apps/api/tests/helpers/service.ts`, change `createService`:

```ts
export interface ServiceOptions {
  readonly strategy?: ConcurrencyStrategy;
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

export function createService(pool: Pool, options: ServiceOptions = {}): ServiceHarness {
  const clock = testClock(START);

  const service = new LedgerService({
    repository: new DrizzleLedgerRepository(),
    unitOfWork: new DrizzleUnitOfWork(createDatabase(pool), {
      strategy: options.strategy ?? 'row-lock',
      onRetry: options.onRetry,
    }),
    clock,
    newId,
  });

  return { service, clock };
}
```

Import `ConcurrencyStrategy` from `../../src/db/client.js`. The two other harnesses in that file build their own `UnitOfWork` object literals — add `strategy: 'row-lock' as const,` to each so they still satisfy the interface.

- [ ] **Step 9: Run the race test against both strategies**

Rewrite the `describe` in `apps/api/tests/concurrency/overdraft.race.test.ts` to parameterize, keeping the file's header comment:

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { ConcurrencyStrategy } from '../../src/db/client.js';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { fireConcurrently, fundedBook } from '../helpers/concurrency.js';
import { balanceOf } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';

const ROUNDS = 5;
const OPENING = 50_000n;
const WITHDRAWAL = 10_000n;
const CONCURRENT = 16;

const STRATEGIES: readonly ConcurrencyStrategy[] = ['row-lock', 'serializable'];

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 20 });
});

afterAll(async () => {
  await pool.end();
});

describe.each(STRATEGIES)('concurrent withdrawals under %s', (strategy) => {
  let service: LedgerService;
  let retries = 0;

  beforeAll(() => {
    retries = 0;
    service = createService(pool, {
      strategy,
      onRetry: () => {
        retries += 1;
      },
    }).service;
  });

  it('never drives a guarded account negative', async () => {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const book = await fundedBook(pool, service, OPENING);

      await fireConcurrently(service, book, CONCURRENT, WITHDRAWAL);

      const balance = await balanceOf(pool, book.bookId, book.cash);

      expect(balance, `round ${round.toString()} left the account overdrawn`).toBeGreaterThanOrEqual(
        0n,
      );
    }
  });

  it('conserves total value regardless of who wins', async () => {
    const book = await fundedBook(pool, service, OPENING);

    await fireConcurrently(service, book, CONCURRENT, WITHDRAWAL);

    const cash = await balanceOf(pool, book.bookId, book.cash);
    const rent = await balanceOf(pool, book.bookId, book.rent);
    const sales = await balanceOf(pool, book.bookId, book.sales);

    expect(cash + rent + sales).toBe(0n);
  });

  it('retries only under serializable, and actually does', () => {
    // A retry path that never runs is untested code. Sixteen writers to one account under
    // SSI will produce 40001s; under row locks they block instead, and there is nothing to
    // retry.
    if (strategy === 'serializable') expect(retries).toBeGreaterThan(0);
    else expect(retries).toBe(0);
  });
});
```

```bash
pnpm --filter @ledger/api exec vitest run --project concurrency
```

Expected: PASS, 8 tests. Record the retry count printed by a temporary `console.log` if you want it for the ADR, then remove the log.

If the serializable rounds fail with `AccountOverdrawnError` counts that look wrong, that is fine — rejections are expected. A failure here means a *negative balance*, which would mean the retry wrapper is swallowing something it should not.

If the serializable rounds exhaust `maxAttempts` and surface a raw 40001 to the caller, that is a genuine result and belongs in the ADR. Raise `maxAttempts` to 10 in the test's `createService` call only, and note both numbers.

- [ ] **Step 10: Run everything**

```bash
pnpm --filter @ledger/api test
pnpm --filter @ledger/api typecheck
```

Expected: PASS, exit 0.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/db/client.ts apps/api/src/db/pg-errors.ts apps/api/src/config.ts apps/api/src/composition.ts apps/api/src/services/ledger.service.ts apps/api/tests/helpers/service.ts apps/api/tests/concurrency/overdraft.race.test.ts apps/api/tests/unit/config.test.ts
git commit -m "feat(db): SERIALIZABLE with retry, as the alternative to row locks

Selected by LEDGER_CONCURRENCY_STRATEGY, defaulting to row-lock. The
race test now runs under both. 40001 is retried; 40P01 deliberately is
not, because a deadlock means the lock ordering is wrong rather than
that the transaction was unlucky."
```

---

### Task 9: The ADR

**Files:**
- Create: `docs/adr/0004-concurrency-control.md`

**Interfaces:**
- Consumes: measurements from Tasks 5, 6, 7 and 8.
- Produces: nothing code depends on.

- [ ] **Step 1: Collect the numbers**

Run each of these and write down what you see. The ADR quotes measurements from this repository, not recollections.

```bash
pnpm --filter @ledger/api exec vitest run --project concurrency --reporter verbose
```

Record: wall-clock duration of the `row-lock` block, of the `serializable` block, and the retry count the `onRetry` counter reached.

```bash
git checkout evidence/overdraft-race && pnpm --filter @ledger/api exec vitest run --project concurrency tests/concurrency/overdraft.race.test.ts; git checkout stage-4-concurrency-and-overdraft
```

Record: which round first went negative, and by how much.

- [ ] **Step 2: Write the ADR**

Create `docs/adr/0004-concurrency-control.md` following the structure of the existing ADRs in `docs/adr/` (if the directory does not exist yet, create it and use the headings below). It must contain:

- **Context** — the overdraft rule, why it constrains every historical prefix, and why "read the balance, check it, insert" is not enough. Name the evidence branch and the round it failed on.
- **The trigger is not a fix** — that `LG004` runs at COMMIT under READ COMMITTED with a fresh snapshot, so it narrows the window and does not close it. Quote the round number the race first failed on before and after Task 6; the difference is the narrowing, measured.
- **Option A: `SELECT ... FOR UPDATE`** — contention is per-account and disjoint accounts never interact; writers block rather than fail; no retry loop and no new caller-visible error; requires deterministic lock ordering, which is `ORDER BY id` and one test. Cost: a writer to a hot account waits for the whole check, and the check is a window scan over that account's postings.
- **Option B: `SERIALIZABLE` + retry on 40001** — no explicit locks; correctness is the database's problem. Cost: the prefix rule makes the read set the account's entire posting range, so SSI predicate-locks broadly and any concurrent insert to that account conflicts. Quote the retry count. The retry wrapper has to wrap the whole unit of work, and anything that must not repeat — the entry id, `recordedAt` — has to be computed outside it.
- **Deadlock risk** — A has it and it is handled by sorting; B does not have deadlocks but has aborts, and 40P01 is deliberately not retried under either.
- **Decision** — `row-lock` ships. The read set the prefix semantics force is the shape SSI handles worst, and blocking degrades better than a 40001 the client has to understand. `LEDGER_CONCURRENCY_STRATEGY=serializable` keeps the alternative runnable and tested.
- **Consequences** — the overdraft check is a window scan under a row lock, which stage 7 revisits with `EXPLAIN ANALYZE` and an index on `postings(account_id)`; and stage 5's property test asserts the invariant over arbitrary entry sequences, which is what will catch a regression in either strategy.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0004-concurrency-control.md
git commit -m "docs: ADR 0004, row locks over SERIALIZABLE for the overdraft rule"
```

---

## Self-review

**Spec coverage.** Every section of the design spec maps to a task: the guarded type and error surface to Task 1, the prefix query to Task 2, the rule in the service and its behavioural tests to Task 3, the concurrency project to Task 4, the evidence commit to Task 5, migration `0007` and `LG004` to Task 6, the row-lock fix and deadlock test to Task 7, `SERIALIZABLE` and the config to Task 8, the ADR to Task 9.

**Two deliberate departures from the spec's file list.** The spec named three test files; this plan writes five, splitting the repository query (`tests/db/overdraft.prefix.test.ts`) and the deadlock case (`tests/concurrency/deadlock.test.ts`) into their own files so each task ends with something independently runnable. It also adds `tests/helpers/concurrency.ts` and `tests/concurrency/harness.test.ts`, which the spec folded into the race test.

**One thing the spec left open, now decided.** `N` is 16 concurrent withdrawals of €100.00 against an opening balance of €500.00, across 5 rounds, with instructions in Tasks 5 and 7 for raising it if the race does not reproduce.

**Type consistency.** `lowestPrefixBalance` returns `LowestPrefix | null` in Tasks 2, 3, 6 and 7. `guardedAccountsAtRisk(legs, known)` has the same signature in Tasks 3 and 7. `assertPostable` returns `Map<string, AccountRecord>` from Task 3 onward, and both call sites are updated in the same step. `AccountOverdrawnError(accountId, shortfall, occurredAt, options?)` is constructed with four arguments in Task 1's test, Task 3's service and Task 6's SQLSTATE translation.
