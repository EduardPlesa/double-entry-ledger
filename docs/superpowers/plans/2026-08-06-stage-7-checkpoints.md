# Stage 7, plan 1 — balance checkpoints keyed on posting id

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An account's balance can be answered as `checkpoint.balance + sum(postings with id > checkpoint.through_id)`, and a test proves that answer always equals the sum from zero.

**Architecture:** A new append-only table `balance_checkpoints`, keyed `(account_id, through_id)`, behind the same row-level security and the same REVOKE pattern as `postings`. Checkpoints are written only by an explicit maintenance call — never by the entry-insert path, which already holds the hottest lock in the system. Two read paths resume from the latest checkpoint: `getBalance` without `asOf`, and the pagination cursor's opening balance. `sumPostings` stays exactly as it is, because the agreement test needs both paths to exist.

**Tech Stack:** TypeScript, Node 22, Express 5, Drizzle ORM 0.45, node-postgres, Postgres 16, Vitest 4, fast-check 4, Testcontainers.

## Global Constraints

- Money is `bigint` minor units everywhere. Never a JS `number`, never a float. SQL sums are cast `::text` and converted with `BigInt()`, because `sum()` over bigint returns numeric.
- Every repository method takes an `Executor` as its first parameter; the caller decides the transaction.
- Every read of `accounts`, `entries`, `postings` and now `balance_checkpoints` must run inside a book-scoped transaction (`unitOfWork.transactionInBook`) or, in tests, `withBookClient` / `queryInBook`. A bare pool query returns zero rows, not an error.
- Migrations are applied as `ledger_owner`; the runtime role is `ledger_app` and can never alter the schema.
- Migrations since `0007` are hand-written SQL with `--> statement-breakpoint` between statements, with the journal entry added by hand. Snapshots in `drizzle/meta/` stop at `0006`.
- Business rules do not live in the repository. The repository knows rows; the service knows what makes them meaningful.
- No new runtime dependency is added by this plan.
- Comments explain *why*, in the voice of the surrounding code. Match the existing density; do not narrate what the code already says.

## File Structure

**Create:**
- `apps/api/drizzle/0008_balance_checkpoints.sql` — the table, its privileges, its policy.
- `apps/api/tests/db/checkpoints.test.ts` — privileges, policy, constraints, against real Postgres.
- `apps/api/tests/services/checkpoint.test.ts` — the service call and the two resuming read paths.
- `apps/api/tests/properties/checkpoint.ts` — the sweep asserting the two paths agree, reusable from the property run.
- `apps/api/tests/properties/checkpoint.property.test.ts` — the property, plus the two pinned regressions.
- `apps/api/scripts/checkpoint.ts` — the maintenance entry point.

**Modify:**
- `apps/api/src/db/schema.ts` — the `balanceCheckpoints` table.
- `apps/api/src/repositories/ledger.repository.ts` — four methods and two types.
- `apps/api/src/services/ledger.service.ts` — `checkpointAccount`, and `getBalance` / `listPostings` resuming.
- `apps/api/tests/services/query-count.test.ts` — the counts change; the reasoning in the comments changes with them.
- `apps/api/package.json` — the `checkpoint` script.

---

### Task 1: The table, its privileges, and its policy

**Files:**
- Create: `apps/api/drizzle/0008_balance_checkpoints.sql`
- Modify: `apps/api/src/db/schema.ts`, `apps/api/drizzle/meta/_journal.json`
- Test: `apps/api/tests/db/checkpoints.test.ts`

**Interfaces:**
- Consumes: `accounts` from `src/db/schema.ts`; the `app.current_book_id` setting established by `db/client.ts`.
- Produces: the `balanceCheckpoints` Drizzle table, exported from `src/db/schema.ts`, with columns `accountId: string`, `bookId: string`, `throughId: bigint`, `balanceMinor: bigint`, `computedAt: Date`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/db/checkpoints.test.ts`. Read `apps/api/tests/db/rls.test.ts` first for the harness shape — this file follows it.

```ts
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { queryInBook, seedBook, withBookClient, withClient } from '../helpers/ledger.js';

/**
 * The checkpoint table's guarantees, at the level the database enforces them.
 *
 * A checkpoint is derived data - it can always be recomputed from the postings - so the
 * interesting assertions are not about its content but about who may change it. Append-only
 * for the runtime role, invisible across books, and impossible to attach to an account in
 * another book.
 */

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: inject('appUrl'), max: 4 });
});

afterAll(async () => {
  await pool.end();
});

async function seed() {
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    const book = await seedBook(client);
    await client.query('COMMIT');
    return book;
  });
}

describe('balance_checkpoints', () => {
  it('accepts an insert and reads it back inside the book', async () => {
    const book = await seed();

    await queryInBook(
      pool,
      book.bookId,
      `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
       VALUES ($1, $2, $3, $4)`,
      [book.cash, book.bookId, '10', '5000'],
    );

    const rows = await queryInBook<{ balance_minor: string; through_id: string }>(
      pool,
      book.bookId,
      'SELECT through_id::text, balance_minor::text FROM balance_checkpoints WHERE account_id = $1',
      [book.cash],
    );

    expect(rows).toEqual([{ through_id: '10', balance_minor: '5000' }]);
  });

  it('refuses UPDATE and DELETE to the runtime role', async () => {
    const book = await seed();

    await queryInBook(
      pool,
      book.bookId,
      `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
       VALUES ($1, $2, 10, 5000)`,
      [book.cash, book.bookId],
    );

    // 42501 is insufficient_privilege: the REVOKE, not a policy and not a trigger.
    await expect(
      queryInBook(pool, book.bookId, 'UPDATE balance_checkpoints SET balance_minor = 0'),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      queryInBook(pool, book.bookId, 'DELETE FROM balance_checkpoints'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('hides another book\'s checkpoints', async () => {
    const mine = await seed();
    const theirs = await seed();

    await queryInBook(
      pool,
      theirs.bookId,
      `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
       VALUES ($1, $2, 10, 5000)`,
      [theirs.cash, theirs.bookId],
    );

    const rows = await queryInBook(pool, mine.bookId, 'SELECT * FROM balance_checkpoints');

    expect(rows).toHaveLength(0);
  });

  it('refuses a checkpoint whose book disagrees with its account', async () => {
    const mine = await seed();
    const theirs = await seed();

    // 23503 is foreign_key_violation: the composite key to (accounts.id, accounts.book_id).
    await expect(
      queryInBook(
        pool,
        mine.bookId,
        `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
         VALUES ($1, $2, 10, 5000)`,
        [theirs.cash, mine.bookId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a second checkpoint at the same watermark', async () => {
    const book = await seed();

    await queryInBook(
      pool,
      book.bookId,
      `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
       VALUES ($1, $2, 10, 5000)`,
      [book.cash, book.bookId],
    );

    // 23505 is unique_violation. The service inserts ON CONFLICT DO NOTHING; this is what
    // that clause is absorbing.
    await expect(
      queryInBook(
        pool,
        book.bookId,
        `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
         VALUES ($1, $2, 10, 9999)`,
        [book.cash, book.bookId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a watermark of zero', async () => {
    const book = await seed();

    // 23514 is check_violation. An account with no postings has no meaningful watermark,
    // and the service declines to write one rather than storing a row that says nothing.
    await expect(
      queryInBook(
        pool,
        book.bookId,
        `INSERT INTO balance_checkpoints (account_id, book_id, through_id, balance_minor)
         VALUES ($1, $2, 0, 0)`,
        [book.cash, book.bookId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
```

Note `withBookClient` is imported for parity with the sibling tests; if the final file does not use it, drop the import rather than leaving it — lint fails on unused imports.

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm --filter @ledger/api test tests/db/checkpoints.test.ts
```

Expected: every case fails with `42P01 relation "balance_checkpoints" does not exist`.

- [ ] **Step 3: Add the table to the Drizzle schema**

In `apps/api/src/db/schema.ts`, after the `postings` table, add:

```ts
/**
 * A balance, and the posting it was true through.
 *
 * `through_id` and not a date, and the difference is the whole reason this table exists. A
 * checkpoint asserts the sum over postings with `id <= through_id`. `postings.id` is a
 * bigserial assigned at insert, so an entry backdated in `occurred_at` still receives ids
 * above everything already stored: the set this row summed is frozen the moment it is
 * written, and no later insert can enter it.
 *
 * A checkpoint keyed on `occurred_at <= D` would assert a sum over a set that is *not*
 * frozen. An entry recorded tomorrow, describing last March, lands inside it - and the
 * stored number is then wrong with nothing in the row to say so. Invalidating it correctly
 * means comparing every entry's `recorded_at` against every checkpoint's date, which is
 * bitemporal bookkeeping and a different system. See docs/adr/0005-balance-checkpoints.md.
 *
 * The same asymmetry bounds what this can accelerate: `asOf` balances and the trial balance
 * filter on `occurred_at`, and `lowestPrefixBalance` is a minimum over prefixes that a
 * backdated entry rewrites behind any watermark. None of those can resume from here.
 */
export const balanceCheckpoints = pgTable(
  'balance_checkpoints',
  {
    accountId: uuid('account_id').notNull(),

    // Denormalised from accounts, exactly as postings.book_id is, and for the same reason:
    // the policy stays a column comparison, and the composite foreign key below makes
    // disagreement impossible.
    bookId: uuid('book_id').notNull(),

    throughId: bigint('through_id', { mode: 'bigint' }).notNull(),
    balanceMinor: bigint('balance_minor', { mode: 'bigint' }).notNull(),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Also the index the read uses: "the latest checkpoint for this account" is a backwards
    // scan of this key, so no secondary index is needed.
    primaryKey({ name: 'balance_checkpoints_pkey', columns: [t.accountId, t.throughId] }),

    foreignKey({
      name: 'balance_checkpoints_account_same_book_fk',
      columns: [t.accountId, t.bookId],
      foreignColumns: [accounts.id, accounts.bookId],
    }),

    // A watermark of zero would be a claim about no postings at all, which the empty sum
    // already answers for free.
    check('balance_checkpoints_through_id_positive', sql`${t.throughId} > 0`),
  ],
);
```

Add `timestamp` to the imports from `drizzle-orm/pg-core` if it is not already there.

- [ ] **Step 4: Write the migration**

Create `apps/api/drizzle/0008_balance_checkpoints.sql`. Hand-written, following `0007_overdraft.sql`'s style: a header comment, `--> statement-breakpoint` between statements, tabs for continuation lines.

```sql
-- Balance checkpoints, keyed on posting id.
--
-- Derived data: every row here can be recomputed from `postings` alone, which is what makes
-- the agreement test in tests/properties/checkpoint.property.test.ts possible and what makes
-- a wrong checkpoint a performance bug rather than a correctness one - the sum-from-zero path
-- still exists and still answers the same question.
--
-- Append-only for ledger_app, by REVOKE, like entries and postings. Deliberately *without*
-- the owner-binding trigger those tables carry from migration 0003: this table is a cache,
-- and pruning superseded rows as the owner has to stay possible. What must not happen is a
-- checkpoint being edited in place, because then a wrong number leaves no trace of having
-- been wrong.

CREATE TABLE balance_checkpoints (
	"account_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"through_id" bigint NOT NULL,
	"balance_minor" bigint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balance_checkpoints_pkey" PRIMARY KEY ("account_id", "through_id"),
	CONSTRAINT "balance_checkpoints_through_id_positive" CHECK ("through_id" > 0)
);--> statement-breakpoint

-- Same book as the account it summarises. One constraint, and it is what lets book_id be
-- denormalised onto this table at all.
ALTER TABLE balance_checkpoints
	ADD CONSTRAINT "balance_checkpoints_account_same_book_fk"
	FOREIGN KEY ("account_id", "book_id") REFERENCES accounts ("id", "book_id");--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE balance_checkpoints TO ledger_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE balance_checkpoints FROM ledger_app;--> statement-breakpoint

ALTER TABLE balance_checkpoints ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY balance_checkpoints_book_isolation ON balance_checkpoints
	FOR ALL
	TO ledger_app
	USING (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid)
	WITH CHECK (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid);
```

Then add the journal entry by hand at the end of `apps/api/drizzle/meta/_journal.json`'s `entries` array, following the `0007_overdraft` entry:

```json
    {
      "idx": 8,
      "version": "7",
      "when": 1786000000000,
      "tag": "0008_balance_checkpoints",
      "breakpoints": true
    }
```

Do not run `pnpm db:generate`. Snapshots stop at `0006` and this migration is hand-written like `0007`; regenerating would emit a second `CREATE TABLE` for a table that now exists.

- [ ] **Step 5: Run the test and watch it pass**

```bash
pnpm --filter @ledger/api test tests/db/checkpoints.test.ts
```

Expected: PASS, all six cases. If the watermark-of-zero case fails with `23514` missing, the CHECK constraint did not make it into the migration — the schema file alone changes nothing about the database.

- [ ] **Step 6: Run the full database suite**

```bash
pnpm --filter @ledger/api test tests/db
```

Expected: PASS. `rls.test.ts` enumerates tables in places; if it asserts a fixed set, add `balance_checkpoints` to it rather than weakening the assertion.

- [ ] **Step 7: Commit**

```bash
git add apps/api/drizzle/0008_balance_checkpoints.sql apps/api/drizzle/meta/_journal.json apps/api/src/db/schema.ts apps/api/tests/db/checkpoints.test.ts
git commit -m "feat(checkpoints): a table for a balance, and the posting it was true through"
```

---

### Task 2: Reading and writing a checkpoint

**Files:**
- Modify: `apps/api/src/repositories/ledger.repository.ts`
- Test: `apps/api/tests/db/checkpoints.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `balanceCheckpoints` from Task 1; `Executor`, `postings`.
- Produces, on `LedgerRepository`:
  - `latestCheckpoint(executor, accountId: string): Promise<BalanceCheckpoint | null>`
  - `computeCheckpoint(executor, accountId: string): Promise<ComputedCheckpoint>`
  - `insertCheckpoint(executor, checkpoint: NewCheckpoint): Promise<boolean>`
  - `sumPostingsAfter(executor, accountId: string, afterId: bigint, throughId?: bigint): Promise<bigint>`
  - types `BalanceCheckpoint { accountId: string; throughId: bigint; balanceMinor: bigint; computedAt: Date }`, `ComputedCheckpoint { throughId: bigint; balanceMinor: bigint }`, `NewCheckpoint { accountId: string; bookId: string; throughId: bigint; balanceMinor: bigint }`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/db/checkpoints.test.ts`. It needs the repository and a unit of work, as `overdraft.prefix.test.ts` does — add those to the existing `beforeAll`.

```ts
describe('checkpoint reads and writes', () => {
  it('computes the watermark and the sum in one statement', async () => {
    const book = await bookWith([
      { occurredAt: '2026-01-10T00:00:00.000Z', amountMinor: 5000n },
      { occurredAt: '2026-01-11T00:00:00.000Z', amountMinor: 2500n },
    ]);

    const computed = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.computeCheckpoint(tx, book.cash),
    );

    expect(computed.balanceMinor).toBe(7500n);
    // Two entries, two legs each: cash holds the positive leg of each.
    expect(computed.throughId).toBeGreaterThan(0n);
  });

  it('reports zero and no watermark for an account with no postings', async () => {
    const book = await bookWith([]);

    const computed = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.computeCheckpoint(tx, book.cash),
    );

    expect(computed).toEqual({ throughId: 0n, balanceMinor: 0n });
  });

  it('returns the highest checkpoint, not the newest row', async () => {
    const book = await bookWith([{ occurredAt: '2026-01-10T00:00:00.000Z', amountMinor: 5000n }]);

    await unitOfWork.transactionInBook(book.bookId, async (tx) => {
      // Written in descending watermark order on purpose: "latest" is the highest
      // through_id, not the most recently inserted row.
      await repository.insertCheckpoint(tx, {
        accountId: book.cash, bookId: book.bookId, throughId: 9n, balanceMinor: 900n,
      });
      await repository.insertCheckpoint(tx, {
        accountId: book.cash, bookId: book.bookId, throughId: 4n, balanceMinor: 400n,
      });
    });

    const latest = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.latestCheckpoint(tx, book.cash),
    );

    expect(latest?.throughId).toBe(9n);
    expect(latest?.balanceMinor).toBe(900n);
  });

  it('reports whether the insert wrote anything', async () => {
    const book = await bookWith([{ occurredAt: '2026-01-10T00:00:00.000Z', amountMinor: 5000n }]);

    const [first, second] = await unitOfWork.transactionInBook(book.bookId, async (tx) => [
      await repository.insertCheckpoint(tx, {
        accountId: book.cash, bookId: book.bookId, throughId: 3n, balanceMinor: 300n,
      }),
      await repository.insertCheckpoint(tx, {
        accountId: book.cash, bookId: book.bookId, throughId: 3n, balanceMinor: 300n,
      }),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('sums the postings after a watermark, and optionally up to a second one', async () => {
    const book = await bookWith([
      { occurredAt: '2026-01-10T00:00:00.000Z', amountMinor: 5000n },
      { occurredAt: '2026-01-11T00:00:00.000Z', amountMinor: 2500n },
      { occurredAt: '2026-01-12T00:00:00.000Z', amountMinor: 1000n },
    ]);

    const ids = await queryInBook<{ id: string }>(
      pool,
      book.bookId,
      'SELECT id::text FROM postings WHERE account_id = $1 ORDER BY id',
      [book.cash],
    );
    const [first, second] = ids.map((row) => BigInt(row.id));

    const after = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.sumPostingsAfter(tx, book.cash, first!),
    );
    const between = await unitOfWork.transactionInBook(book.bookId, (tx) =>
      repository.sumPostingsAfter(tx, book.cash, first!, second!),
    );

    expect(after).toBe(3500n);
    expect(between).toBe(2500n);
  });
});
```

`bookWith` is the helper from `tests/db/overdraft.prefix.test.ts`; copy it into this file rather than exporting it across test files — it is six lines and the two versions seed different books.

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm --filter @ledger/api test tests/db/checkpoints.test.ts
```

Expected: FAIL — `repository.computeCheckpoint is not a function`.

- [ ] **Step 3: Add the types and interface methods**

In `apps/api/src/repositories/ledger.repository.ts`, next to `LowestPrefix`:

```ts
/** A stored balance, and the posting id it is true through. */
export interface BalanceCheckpoint {
  readonly accountId: string;
  readonly throughId: bigint;
  readonly balanceMinor: bigint;
  readonly computedAt: Date;
}

/** What a checkpoint would say if written now. `throughId` is 0 when the account has no postings. */
export interface ComputedCheckpoint {
  readonly throughId: bigint;
  readonly balanceMinor: bigint;
}

export interface NewCheckpoint {
  readonly accountId: string;
  readonly bookId: string;
  readonly throughId: bigint;
  readonly balanceMinor: bigint;
}
```

And on the `LedgerRepository` interface, below `sumPostingsThrough`:

```ts
  /** The account's highest checkpoint, or null if it has none. */
  latestCheckpoint(executor: Executor, accountId: string): Promise<BalanceCheckpoint | null>;
  /** The checkpoint the account's postings would justify right now. One statement, one snapshot. */
  computeCheckpoint(executor: Executor, accountId: string): Promise<ComputedCheckpoint>;
  /** Writes a checkpoint. False when one already exists at that watermark. */
  insertCheckpoint(executor: Executor, checkpoint: NewCheckpoint): Promise<boolean>;
  /** Sum of an account's postings after a watermark, optionally stopping at a second one. */
  sumPostingsAfter(
    executor: Executor,
    accountId: string,
    afterId: bigint,
    throughId?: bigint | undefined,
  ): Promise<bigint>;
```

- [ ] **Step 4: Implement them**

In `DrizzleLedgerRepository`, after `sumPostingsThrough`. Add `desc` to the `drizzle-orm` import and `balanceCheckpoints` to the schema import.

```ts
  async latestCheckpoint(executor: Executor, accountId: string): Promise<BalanceCheckpoint | null> {
    const [row] = await executor
      .select({
        accountId: balanceCheckpoints.accountId,
        throughId: balanceCheckpoints.throughId,
        balanceMinor: balanceCheckpoints.balanceMinor,
        computedAt: balanceCheckpoints.computedAt,
      })
      .from(balanceCheckpoints)
      .where(eq(balanceCheckpoints.accountId, accountId))
      // A backwards scan of the primary key. "Latest" is the highest watermark and not the
      // most recent write: a checkpoint recomputed at an older watermark is still older.
      .orderBy(desc(balanceCheckpoints.throughId))
      .limit(1);

    return row ?? null;
  }

  /**
   * The watermark and the sum, from one statement and therefore from one snapshot.
   *
   * Two statements would be a bug with a narrow window and a permanent consequence: a
   * posting committed between them lands above the watermark this reads and below the sum
   * that reads it, and every balance served from the resulting checkpoint is short by
   * exactly that posting until a later checkpoint supersedes it.
   */
  async computeCheckpoint(executor: Executor, accountId: string): Promise<ComputedCheckpoint> {
    const [row] = await executor
      .select({
        throughId: sql<string>`coalesce(max(${postings.id}), 0)::text`,
        balanceMinor: sql<string>`coalesce(sum(${postings.amountMinor}), 0)::text`,
      })
      .from(postings)
      .where(eq(postings.accountId, accountId));

    return {
      throughId: BigInt(row?.throughId ?? '0'),
      balanceMinor: BigInt(row?.balanceMinor ?? '0'),
    };
  }

  /**
   * ON CONFLICT DO NOTHING, because recomputing at an unchanged watermark produces the same
   * number: a repeated refresh is a no-op rather than an error, and the maintenance script
   * can be run twice without anyone having to think about it.
   */
  async insertCheckpoint(executor: Executor, checkpoint: NewCheckpoint): Promise<boolean> {
    const written = await executor
      .insert(balanceCheckpoints)
      .values({
        accountId: checkpoint.accountId,
        bookId: checkpoint.bookId,
        throughId: checkpoint.throughId,
        balanceMinor: checkpoint.balanceMinor,
      })
      .onConflictDoNothing()
      .returning({ throughId: balanceCheckpoints.throughId });

    return written.length > 0;
  }

  async sumPostingsAfter(
    executor: Executor,
    accountId: string,
    afterId: bigint,
    throughId?: bigint | undefined,
  ): Promise<bigint> {
    const conditions = [eq(postings.accountId, accountId), gt(postings.id, afterId)];
    if (throughId !== undefined) conditions.push(lte(postings.id, throughId));

    const [row] = await executor
      .select({ total: sql<string>`coalesce(sum(${postings.amountMinor}), 0)::text` })
      .from(postings)
      .where(and(...conditions));

    return BigInt(row?.total ?? '0');
  }
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
pnpm --filter @ledger/api test tests/db/checkpoints.test.ts
```

Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @ledger/api typecheck
```

Expected: clean. If `sumPostingsAfter`'s optional parameter errors, it is `exactOptionalPropertyTypes` — the interface declares `bigint | undefined`, and the implementation must too.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/repositories/ledger.repository.ts apps/api/tests/db/checkpoints.test.ts
git commit -m "feat(checkpoints): compute one from a single snapshot, and read the highest"
```

---

### Task 3: The service writes one, and two reads resume from it

**Files:**
- Modify: `apps/api/src/services/ledger.service.ts`, `apps/api/tests/services/query-count.test.ts`
- Test: `apps/api/tests/services/checkpoint.test.ts`

**Interfaces:**
- Consumes: Task 2's four repository methods; `requireAccount`, `unitOfWork.transactionInBook`, `money` from `@ledger/shared`.
- Produces:
  - `LedgerService.checkpointAccount(bookId: string, accountId: string): Promise<CheckpointResult>` where `CheckpointResult { accountId: string; throughId: bigint; balance: Money; written: boolean }`
  - private `balanceThrough(tx: Executor, accountId: string, throughId?: bigint): Promise<bigint>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/services/checkpoint.test.ts`, following `tests/services/ledger.service.test.ts` for harness setup (`createService`, `seedBookIn`).

```ts
/**
 * The checkpoint, through the service.
 *
 * Every case here asserts the same thing twice over: that the fast path returns what the
 * sum from zero returns. The property test generalises it; these pin the two shapes that
 * motivated the design - an entry that lands *behind* a checkpoint, and a reversal recorded
 * after one.
 */

describe('checkpointAccount', () => {
  it('writes nothing for an account with no postings', async () => {
    const result = await service.checkpointAccount(book.bookId, book.rent);

    expect(result.written).toBe(false);
    expect(result.throughId).toBe(0n);
  });

  it('is a no-op when run twice with nothing in between', async () => {
    await post({ amountMinor: 5000n, occurredAt: '2026-02-01T00:00:00.000Z' });

    const first = await service.checkpointAccount(book.bookId, book.cash);
    const second = await service.checkpointAccount(book.bookId, book.cash);

    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(second.throughId).toBe(first.throughId);
  });

  it('serves the same balance through a checkpoint as from zero', async () => {
    await post({ amountMinor: 5000n, occurredAt: '2026-02-01T00:00:00.000Z' });
    await service.checkpointAccount(book.bookId, book.cash);
    await post({ amountMinor: 2500n, occurredAt: '2026-02-02T00:00:00.000Z' });

    const balance = await service.getBalance(book.bookId, book.cash);

    expect(balance.balance.minor).toBe(7500n);
  });

  it('is unmoved by an entry backdated behind the checkpoint', async () => {
    await post({ amountMinor: 5000n, occurredAt: '2026-02-10T00:00:00.000Z' });
    await service.checkpointAccount(book.bookId, book.cash);

    // Recorded now, occurred before everything the checkpoint summed. Its posting id is
    // still above the watermark, which is the entire argument for keying on id.
    await post({ amountMinor: 1000n, occurredAt: '2026-01-01T00:00:00.000Z' });

    const balance = await service.getBalance(book.bookId, book.cash);

    expect(balance.balance.minor).toBe(6000n);
  });

  it('is unmoved by a reversal recorded after the checkpoint', async () => {
    const entry = await post({ amountMinor: 5000n, occurredAt: '2026-02-10T00:00:00.000Z' });
    await service.checkpointAccount(book.bookId, book.cash);
    await service.reverseEntry(book.bookId, entry.id, {});

    const balance = await service.getBalance(book.bookId, book.cash);

    expect(balance.balance.minor).toBe(0n);
  });

  it('ignores the checkpoint for an asOf read', async () => {
    await post({ amountMinor: 5000n, occurredAt: '2026-02-01T00:00:00.000Z' });
    await service.checkpointAccount(book.bookId, book.cash);
    await post({ amountMinor: 1000n, occurredAt: '2026-01-01T00:00:00.000Z' });

    const asOf = await service.getBalance(book.bookId, book.cash, new Date('2026-01-15T00:00:00.000Z'));

    // The backdated entry counts and the checkpointed one does not: an occurred_at question,
    // answered from zero, because an id-keyed checkpoint cannot answer it.
    expect(asOf.balance.minor).toBe(1000n);
  });

  it('opens a page from the checkpoint and agrees with the sum from zero', async () => {
    for (let i = 0; i < 5; i += 1) {
      await post({ amountMinor: 1000n, occurredAt: `2026-02-0${(i + 1).toString()}T00:00:00.000Z` });
    }
    await service.checkpointAccount(book.bookId, book.cash);

    const first = await service.listPostings(book.bookId, book.cash, { limit: 2 });
    const second = await service.listPostings(book.bookId, book.cash, {
      cursor: first.nextCursor!,
      limit: 2,
    });

    // The third and fourth postings, so the running balance opens at 2000 and closes at 4000.
    expect(second.postings[0]?.balance.minor).toBe(3000n);
    expect(second.postings[1]?.balance.minor).toBe(4000n);
  });
});
```

Write the `post` helper against `service.recordEntry`'s real signature — read `tests/services/ledger.service.test.ts` and copy the shape it already uses; two legs, `book.cash` positive and `book.sales` negative. Check `PostingPage`'s cursor field name in `src/services/ledger.service.ts` before using `nextCursor`, and use whatever it is actually called.

- [ ] **Step 2: Run the test and watch it fail**

```bash
pnpm --filter @ledger/api test tests/services/checkpoint.test.ts
```

Expected: FAIL — `service.checkpointAccount is not a function`.

- [ ] **Step 3: Implement `checkpointAccount`**

In `apps/api/src/services/ledger.service.ts`, near `getBalance`:

```ts
export interface CheckpointResult {
  readonly accountId: string;
  readonly throughId: bigint;
  readonly balance: Money;
  /** False when a checkpoint already existed at this watermark, or the account has no postings. */
  readonly written: boolean;
}
```

```ts
  /**
   * Writes a checkpoint for one account.
   *
   * Called by the maintenance script and by tests, never by the write path. Stage 4's ADR is
   * about keeping the entry-insert critical section narrow, and it holds the account's row
   * lock while a prefix scan runs; adding a write to it to make a *read* faster would be
   * paying in the one currency this system is short of.
   *
   * A stale checkpoint costs read time and never correctness: the balance is still
   * `checkpoint + everything after it`, however long ago the checkpoint was taken.
   */
  async checkpointAccount(bookId: string, accountId: string): Promise<CheckpointResult> {
    return this.unitOfWork.transactionInBook(bookId, async (tx) => {
      const account = await this.requireAccount(tx, accountId);
      const computed = await this.repository.computeCheckpoint(tx, accountId);

      // No postings, no watermark. The empty sum already answers this account for free, and
      // the CHECK constraint on `through_id` refuses the row anyway.
      if (computed.throughId === 0n) {
        return { accountId, throughId: 0n, balance: money(0n, account.currency), written: false };
      }

      const written = await this.repository.insertCheckpoint(tx, {
        accountId,
        bookId,
        throughId: computed.throughId,
        balanceMinor: computed.balanceMinor,
      });

      return {
        accountId,
        throughId: computed.throughId,
        balance: money(computed.balanceMinor, account.currency),
        written,
      };
    });
  }
```

- [ ] **Step 4: Route the two reads through the checkpoint**

Add the private helper:

```ts
  /**
   * An account's balance, through a posting id or through all of them, resuming from the
   * latest checkpoint when there is one that helps.
   *
   * "That helps" is the second condition: a checkpoint above the requested `throughId`
   * summed postings the caller has asked to exclude, so it is not a starting point for this
   * question and the sum from zero answers it instead. That happens on any page whose cursor
   * points behind the newest checkpoint, which is every page but the last few.
   */
  private async balanceThrough(
    tx: Executor,
    accountId: string,
    throughId?: bigint | undefined,
  ): Promise<bigint> {
    const checkpoint = await this.repository.latestCheckpoint(tx, accountId);

    if (checkpoint === null || (throughId !== undefined && checkpoint.throughId > throughId)) {
      return throughId === undefined
        ? this.repository.sumPostings(tx, accountId)
        : this.repository.sumPostingsThrough(tx, accountId, throughId);
    }

    const delta = await this.repository.sumPostingsAfter(
      tx,
      accountId,
      checkpoint.throughId,
      throughId,
    );

    return checkpoint.balanceMinor + delta;
  }
```

In `getBalance`, replace the `sumPostings` call:

```ts
      const total =
        asOf === undefined
          ? await this.balanceThrough(tx, accountId)
          : // An occurred_at question. The checkpoint knows nothing about the dates of the
            // postings it summed, so this stays a sum from zero - see the table comment.
            await this.repository.sumPostings(tx, accountId, asOf);
```

In `listPostings`, replace the opening-balance call:

```ts
      const opening =
        afterId === undefined ? 0n : await this.balanceThrough(tx, accountId, afterId);
```

Update the doc comment above `listPostings` — it currently says stage 7 *will* replace that query. It has.

- [ ] **Step 5: Run the test and watch it pass**

```bash
pnpm --filter @ledger/api test tests/services/checkpoint.test.ts
```

Expected: PASS.

- [ ] **Step 6: Fix the query counts**

```bash
pnpm --filter @ledger/api test tests/services/query-count.test.ts
```

Expected: FAIL. `getBalance` and `listPostings` each issue one more query than before — the checkpoint lookup — and the delta sum replaces the sum from zero rather than adding to it.

Update the expected counts to what the run reports, and rewrite the comments to say why: the count is one higher and still constant, which is the property the test exists to defend. A per-page or per-account count is what would be a regression. Do not weaken an assertion to a range.

- [ ] **Step 7: Run the whole suite**

```bash
pnpm --filter @ledger/api test
```

Expected: PASS. The property suite in `tests/properties` exercises `getBalance` heavily and will fail loudly if `balanceThrough` is wrong in a way the service tests missed.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/ledger.service.ts apps/api/tests/services/checkpoint.test.ts apps/api/tests/services/query-count.test.ts
git commit -m "feat(checkpoints): the balance and the cursor resume from the highest one"
```

---

### Task 4: The property — both paths, always, whatever the sequence

**Files:**
- Create: `apps/api/tests/properties/checkpoint.ts`, `apps/api/tests/properties/checkpoint.property.test.ts`
- Test: both of the above

**Interfaces:**
- Consumes: `createPropertyBook`, `PropertyBook` from `tests/properties/fixture.ts`; `ledgerCommands` from `tests/properties/commands.ts`; `propertyRuns` from `tests/properties/runs.ts`; `LedgerService.checkpointAccount` from Task 3.
- Produces: `assertCheckpointAgreement(book: PropertyBook): Promise<void>`

- [ ] **Step 1: Write the sweep**

Create `apps/api/tests/properties/checkpoint.ts`, modelled on `prefix.ts`:

```ts
import { expect } from 'vitest';
import { DrizzleLedgerRepository } from '../../src/repositories/ledger.repository.js';
import type { PropertyBook } from './fixture.js';

/**
 * The two paths agree, for every account, whatever happened.
 *
 * Not a comparison against the model: both numbers come from the database. The model already
 * pins what the balance *should* be; this pins that the fast path and the slow path cannot
 * disagree about it - which is the only failure mode a checkpoint introduces, and the one a
 * date-keyed checkpoint would exhibit the moment a backdated entry arrived.
 *
 * Read in one transaction per account so the two sums see the same snapshot. Across two
 * transactions a concurrent write could land between them and produce a difference that is
 * not a bug.
 */

const repository = new DrizzleLedgerRepository();

export async function assertCheckpointAgreement(book: PropertyBook): Promise<void> {
  for (const account of book.accounts) {
    const [viaCheckpoint, fromZero] = await book.unitOfWork.transactionInBook(
      book.bookId,
      async (tx) => {
        const checkpoint = await repository.latestCheckpoint(tx, account.id);
        const resumed =
          checkpoint === null
            ? await repository.sumPostings(tx, account.id)
            : checkpoint.balanceMinor +
              (await repository.sumPostingsAfter(tx, account.id, checkpoint.throughId));

        return [resumed, await repository.sumPostings(tx, account.id)];
      },
    );

    expect(viaCheckpoint, `checkpointed balance of ${account.name}`).toBe(fromZero);
  }
}
```

- [ ] **Step 2: Write the property**

Create `apps/api/tests/properties/checkpoint.property.test.ts`. Read `ledger.property.test.ts` first and follow its structure exactly — the pool, the throwaway shape book, `fc.asyncModelRun`, `propertyRuns()`.

```ts
/**
 * Arbitrary sequences, with checkpoints taken at arbitrary moments inside them.
 *
 * The checkpoints are the point. Taking one only at the end would test a suffix sum of
 * length zero; taking them partway through a sequence that keeps writing - including
 * backdated entries and reversals, which is what `ledgerCommands` generates - is what puts
 * a watermark behind entries that arrive later.
 */
it('a checkpointed balance always equals the sum from zero', async () => {
  const tally: Tally = { accepted: 0, refused: 0, reversalsAccepted: 0, reversalsRefused: 0 };
  const shape = accountsOf(await seedBookIn(pool));
  const commands = ledgerCommands(shape, tally);

  await fc.assert(
    fc.asyncProperty(
      commands,
      // Where in the sequence to checkpoint, and which account. Indices, resolved against
      // this case's own accounts inside the run, for the same reason the commands are.
      fc.array(fc.nat({ max: 40 }), { minLength: 1, maxLength: 4 }),
      async (commands, checkpointAt) => {
        const book = await createPropertyBook(pool);
        const model = book.newModel();
        const points = new Set(checkpointAt);

        let index = 0;
        for (const command of commands) {
          await fc.asyncModelRun(() => ({ model, real: realOf(book) }), [command]);

          if (points.has(index)) {
            for (const account of book.accounts) {
              await book.service.checkpointAccount(book.bookId, account.id);
            }
          }
          index += 1;
        }

        await assertCheckpointAgreement(book);
      },
    ),
    { numRuns: propertyRuns() },
  );

  expect(tally.accepted, 'no entry was ever accepted').toBeGreaterThan(0);
});
```

`realOf(book)` builds the `Real` object `ledger.property.test.ts` constructs inline (`{ bookId, service, unitOfWork }`) — write it as a small local function in this file. If `fc.asyncModelRun` cannot be called once per command in this fast-check version, drive the commands with a plain loop calling `command.check(model)` and `command.run(model, real)` directly, and say so in a comment.

- [ ] **Step 3: Add the two pinned regressions**

In the same file, outside the property:

```ts
/**
 * The two shapes the design exists for, pinned so a generator change cannot quietly stop
 * covering them. A shrunk counterexample is a fine way to find a bug and a poor way to keep
 * a guarantee.
 */
describe('checkpoints behind later writes', () => {
  it('survives an entry backdated behind the watermark', async () => { /* ... */ });
  it('survives a reversal recorded after the watermark', async () => { /* ... */ });
});
```

Write both bodies against the real service: post, checkpoint every account, post the backdated entry (or reverse the earlier one), then `await assertCheckpointAgreement(book)`. These duplicate the service tests' scenarios at the property fixture's level on purpose — the service test asserts a number, this asserts the two paths agree.

- [ ] **Step 4: Run it**

```bash
pnpm --filter @ledger/api test tests/properties/checkpoint.property.test.ts
```

Expected: PASS. If it fails, do not adjust the assertion — a disagreement between the two paths is the bug this plan exists to prevent. Read the shrunk case and fix `balanceThrough`.

- [ ] **Step 5: Prove the test can fail**

Temporarily break `balanceThrough` — return `checkpoint.balanceMinor` without the delta — and run the property again.

Expected: FAIL, with a shrunk counterexample. Revert the break.

A property that cannot fail is the standing failure mode of property testing, and this one is cheap to verify.

- [ ] **Step 6: Run the whole suite**

```bash
pnpm --filter @ledger/api test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/tests/properties/checkpoint.ts apps/api/tests/properties/checkpoint.property.test.ts
git commit -m "test(checkpoints): the fast path and the slow path agree, whatever the sequence"
```

---

### Task 5: The maintenance entry point

**Files:**
- Create: `apps/api/scripts/checkpoint.ts`
- Modify: `apps/api/package.json`, `apps/api/src/db/schema.ts` (the `postings` index comment)

**Interfaces:**
- Consumes: `LedgerService.checkpointAccount`; `getConfig` from `src/config.ts`; the composition helpers in `src/composition.ts`.
- Produces: `pnpm --filter @ledger/api checkpoint <bookId>`, which checkpoints every account in a book and prints one line each.

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/checkpoint.ts`. Read `src/composition.ts` first and build the service the way the application does, rather than assembling one here.

```ts
/**
 * Refreshes every checkpoint in a book.
 *
 * A script and not a scheduler, and `docs/limitations.md` says so plainly: nothing runs this
 * automatically. That is a real gap, and it is a cheap one - a stale checkpoint makes reads
 * slower and never makes them wrong, so the failure mode of never running this is the
 * performance the system had before checkpoints existed.
 */
```

It takes the book id as `process.argv[2]`, exits non-zero with a usage line when it is missing, lists the book's accounts, calls `checkpointAccount` for each, and prints `<account id> <balance> through <through id> (written|unchanged)`.

- [ ] **Step 2: Add the package script**

In `apps/api/package.json`:

```json
    "checkpoint": "node --env-file-if-exists=../../.env --import tsx scripts/checkpoint.ts",
```

Match `db:migrate`'s form exactly — same env-file flag, same loader.

- [ ] **Step 3: Run it against the dev database**

```bash
pnpm db:up
```

```bash
pnpm db:migrate
```

Then create a book through the API or reuse one, and run:

```bash
pnpm --filter @ledger/api checkpoint <bookId>
```

Expected: one line per account, and a second run reporting `unchanged` for every account that saw no writes in between.

- [ ] **Step 4: Rewrite the postings index comment**

`apps/api/src/db/schema.ts` still says stage 7 will add `postings(account_id, id)` "with EXPLAIN ANALYZE either side". Plan 2 does that. Amend the comment to say the checkpoint read added in this plan is one of the queries that index is measured against — do not claim the index exists yet.

- [ ] **Step 5: Typecheck, lint, test**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm test
```

Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/checkpoint.ts apps/api/package.json apps/api/src/db/schema.ts
git commit -m "feat(checkpoints): a script to refresh a book's, since nothing schedules it"
```

---

## Done when

- `balance_checkpoints` exists, is append-only for `ledger_app`, is invisible across books, and refuses a row whose book disagrees with its account.
- `getBalance` without `asOf` and the pagination cursor's opening balance both resume from the highest checkpoint, and fall back to the sum from zero when there is none or when the checkpoint is above the requested watermark.
- `getBalance` *with* `asOf` still sums from zero, and a test says why.
- The property passes over generated sequences with checkpoints taken partway through, and fails when `balanceThrough` is broken on purpose.
- The two pinned regressions — backdated behind a checkpoint, reversal after one — pass.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` are clean.
