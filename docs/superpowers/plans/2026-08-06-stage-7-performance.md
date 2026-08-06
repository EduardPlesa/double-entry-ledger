# Stage 7, plan 2 — 500,000 postings, and the plans either side of the indexes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible 500,000-posting corpus, `EXPLAIN ANALYZE` for five queries captured before and after two indexes, and `docs/performance.md` holding both sets of plans with the analysis that reads them.

**Architecture:** Two scripts and one migration. `seed-perf.ts` bulk-loads balanced entries as the owner role with the constraint triggers off, then verifies in bulk what the triggers would have checked row by row. `explain.ts` runs the five queries as the *runtime* role inside a book-scoped transaction — so the captured plan includes the row-level security predicate the application actually pays for — in `--baseline` or `--indexed` mode. Migration `0009` adds the two indexes.

**Tech Stack:** TypeScript, Node 22, node-postgres, Postgres 16, Drizzle ORM, tsx.

## Global Constraints

- Prerequisite: plan 1 is merged. Query 2 below is the checkpoint read it added.
- The seed connects with `DATABASE_MIGRATION_URL` (`ledger_owner`). Disabling a trigger requires table ownership, and the owner is exempt from row-level security, which the bulk insert needs.
- The EXPLAIN harness connects with `DATABASE_URL` (`ledger_app`) and sets `app.current_book_id` in the transaction. A plan captured as the owner is a plan no request ever gets.
- Determinism: `SELECT setseed(...)` before any `random()`, and every parameter a named constant at the top of the script. A corpus nobody can rebuild is a number nobody can check.
- Money stays `bigint` minor units, including in generated SQL.
- Migrations are hand-written since `0007`, with the journal entry added by hand and no snapshot.
- Nothing in this plan writes to the test database. Testcontainers suites are untouched.

## File Structure

**Create:**
- `apps/api/scripts/seed-perf.ts` — corpus generation and verification.
- `apps/api/scripts/explain.ts` — plan capture, `--baseline` and `--indexed`.
- `apps/api/drizzle/0009_indexes.sql` — the two indexes.
- `docs/performance.md` — the document this plan exists to produce.

**Modify:**
- `apps/api/src/db/schema.ts` — the index declarations, and the comment that has been deferring them since stage 1.
- `apps/api/package.json` — `perf:seed` and `perf:explain` scripts.

---

### Task 1: The corpus

**Files:**
- Create: `apps/api/scripts/seed-perf.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: `getConfig()` from `src/config.ts` for `database.migrationUrl`.
- Produces: `pnpm --filter @ledger/api perf:seed [--postings N]`, printing the book id it created and the verification results. Default `N` is 500,000.

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/seed-perf.ts`. Structure it as: constants, then `main()`, then the phases as small functions.

```ts
/**
 * A corpus big enough for the plans to mean something.
 *
 * 250,000 entries of two legs each. Bulk `INSERT ... SELECT FROM generate_series` rather than
 * 250,000 round trips through the service, and as ledger_owner rather than ledger_app: the
 * owner is exempt from row-level security, which is what lets one statement write a book's
 * worth of rows.
 *
 * The constraint triggers are disabled for the load and re-enabled after it. They are not
 * being bypassed - what they check is checked here too, once, in bulk, by the verification
 * queries at the end. Firing a deferred per-entry trigger 250,000 times and a per-posting
 * overdraft scan 250,000 times would cost many minutes to establish what two aggregate
 * queries establish in seconds. The difference matters only because this script is expected
 * to be re-run whenever the numbers are re-taken.
 *
 * Every parameter below is a constant and the RNG is seeded, so the corpus is the same
 * corpus on any machine. docs/performance.md quotes these values; if you change one, change
 * them there too or the plans stop being reproducible.
 */

const POSTINGS = 500_000;          // two per entry
const ASSET_ACCOUNTS = 100;
const REVENUE_ACCOUNTS = 100;
const START = '2023-01-01T00:00:00Z';
const SPAN_DAYS = 1095;            // three years
const BACKDATED_EVERY = 10;        // one entry in ten occurs before its predecessor
const BACKDATE_MAX_DAYS = 180;
const RNG_SEED = 0.42;
const CURRENCY = 'EUR';
```

The phases:

1. **Book and accounts.** One book. `ASSET_ACCOUNTS` accounts of type `asset` and `REVENUE_ACCOUNTS` of type `revenue`, all `CURRENCY`, inserted from `generate_series` with `gen_random_uuid()`.
2. **Disable the triggers.** As owner:

```sql
ALTER TABLE postings DISABLE TRIGGER postings_entry_balanced;
ALTER TABLE postings DISABLE TRIGGER postings_account_not_overdrawn;
ALTER TABLE entries  DISABLE TRIGGER entries_have_postings;
```

3. **Entries.** `SELECT setseed(RNG_SEED)` first, then one statement:

```sql
INSERT INTO entries (id, book_id, occurred_at, recorded_at, description, external_id)
SELECT
  gen_random_uuid(),
  $1,
  -- Mostly forward through the span, with one entry in ten landing up to
  -- BACKDATE_MAX_DAYS earlier. That skew is the point of the corpus: a ledger whose
  -- occurred_at order matched its id order would never exercise the distinction the
  -- checkpoint design rests on.
  $2::timestamptz
    + (i * ($3::numeric / $4)) * interval '1 day'
    - CASE WHEN i % $5 = 0 THEN (random() * $6) * interval '1 day' ELSE interval '0' END,
  now(),
  'seed ' || i,
  NULL
FROM generate_series(1, $4) AS i;
```

4. **Postings.** Two legs per entry: the positive one to an asset account, the negative one to a revenue account. Asset accounts therefore only ever receive credit, so no guarded account can go negative — which is what makes step 6's third verification pass rather than a discovery. The account is chosen by the entry's row number rather than by `random()`, so the distribution is fixed across runs:

```sql
WITH numbered AS (
  SELECT
    e.id,
    e.book_id,
    row_number() OVER (ORDER BY e.occurred_at, e.id) AS n,
    -- 100 to 200 000 minor units, from the row number rather than a fresh random(), so the
    -- amounts are the same corpus on every run without depending on evaluation order.
    (100 + (row_number() OVER (ORDER BY e.occurred_at, e.id) * 7919) % 199901)::bigint AS amount
  FROM entries e
  WHERE e.book_id = $1
),
assets AS (
  SELECT id, row_number() OVER (ORDER BY id) - 1 AS k
  FROM accounts WHERE book_id = $1 AND type = 'asset'
),
revenues AS (
  SELECT id, row_number() OVER (ORDER BY id) - 1 AS k
  FROM accounts WHERE book_id = $1 AND type = 'revenue'
)
INSERT INTO postings (entry_id, book_id, account_id, amount_minor, currency)
SELECT n.id, n.book_id, a.id, n.amount, $2
FROM numbered n JOIN assets a ON a.k = n.n % $3
UNION ALL
SELECT n.id, n.book_id, r.id, -n.amount, $2
FROM numbered n JOIN revenues r ON r.k = (n.n / $3) % $4;
```

`$3` is `ASSET_ACCOUNTS` and `$4` is `REVENUE_ACCOUNTS`. The two legs of one entry share an `entry_id`, so the deferred balance trigger — were it enabled — would see them as one entry summing to zero.

5. **Re-enable the triggers.** `ENABLE TRIGGER` for all three, in the same statement order. Do this in a `finally`, so a failed load does not leave the database with its invariants switched off.
6. **Verify.** Three queries, each printing its result:

```sql
-- Every entry sums to zero, per currency. What postings_entry_balanced would have checked.
SELECT count(*) AS unbalanced FROM (
  SELECT entry_id FROM postings GROUP BY entry_id, currency HAVING sum(amount_minor) <> 0
) bad;

-- Every entry has legs. What entries_have_postings would have checked.
SELECT count(*) AS legless FROM entries e
WHERE NOT EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id);

-- No guarded account is ever negative. What postings_account_not_overdrawn would have
-- checked, once per account instead of once per inserted posting.
SELECT count(*) AS overdrawn FROM (
  SELECT a.id, min(sum(p.amount_minor) OVER (
    PARTITION BY p.account_id ORDER BY e.occurred_at, p.id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)) AS lowest
  FROM accounts a JOIN postings p ON p.account_id = a.id JOIN entries e ON e.id = p.entry_id
  WHERE a.type = 'asset' GROUP BY a.id
) prefixes WHERE lowest < 0;
```

The third needs a subquery around the window function — `min()` over a window result cannot be nested directly. Write it as an inner query producing the running sums and an outer one taking the minimum per account.

Exit non-zero if any of the three returns a non-zero count. A seed that produced invalid data must fail loudly, because everything downstream measures it.

7. **Print** the book id, the row counts, and the elapsed time per phase.

Support `--postings N` so CI can run the same script small. `ANALYZE entries; ANALYZE postings;` at the end — a fresh bulk load has no statistics, and a plan taken against stale statistics is a plan of a database nobody has.

- [ ] **Step 2: Add the package script**

In `apps/api/package.json`:

```json
    "perf:seed": "node --env-file-if-exists=../../.env --import tsx scripts/seed-perf.ts",
```

- [ ] **Step 3: Run it small and watch it verify**

```bash
pnpm db:up
```

```bash
pnpm db:migrate
```

```bash
pnpm --filter @ledger/api perf:seed --postings 2000
```

Expected: a book id, `unbalanced 0`, `legless 0`, `overdrawn 0`, and a non-zero exit only if one of them is not zero.

- [ ] **Step 4: Prove the verification can fail**

Temporarily change the posting insert so one leg in a thousand is off by one minor unit, and re-run at `--postings 2000`.

Expected: `unbalanced` greater than zero and a non-zero exit code. Revert.

A verification that has never failed is a verification nobody has checked.

- [ ] **Step 5: Run it at full size**

```bash
pnpm --filter @ledger/api perf:seed
```

Expected: 500,000 postings, all three checks zero. Record the elapsed time — `docs/performance.md` quotes it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/seed-perf.ts apps/api/package.json
git commit -m "perf(seed): a reproducible 500k-posting corpus, verified in bulk"
```

---

### Task 2: The plan capture

**Files:**
- Create: `apps/api/scripts/explain.ts`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: `getConfig()` for both URLs; the book id printed by Task 1.
- Produces: `pnpm --filter @ledger/api perf:explain --book <id> --mode baseline|indexed`, printing a Markdown section ready to paste into `docs/performance.md`.

- [ ] **Step 1: Write the script**

Create `apps/api/scripts/explain.ts`.

```ts
/**
 * The plans, as the application gets them.
 *
 * Connected as ledger_app inside a transaction with `app.current_book_id` set, because the
 * row-level security predicate is part of every one of these queries in production and a
 * plan captured as the owner would omit it. That is the difference between measuring the
 * system and measuring a query that resembles it.
 *
 * `--mode baseline` drops the stage-7 indexes before capturing; `--mode indexed` creates
 * them. Both run as the owner, since ledger_app cannot alter the schema - which is the point
 * of that split and not an inconvenience.
 */
```

The five queries, each with a name, the SQL, and one sentence on what it answers:

1. **`balance-from-zero`** — `SELECT coalesce(sum(amount_minor), 0)::text FROM postings WHERE account_id = $1`. The naive path, still the only answer for an account with no checkpoint.
2. **`balance-from-checkpoint`** — the checkpoint lookup (`ORDER BY through_id DESC LIMIT 1`) and the delta sum (`WHERE account_id = $1 AND id > $2`), captured as two plans under one heading, because the read is two statements.
3. **`lowest-prefix`** — the window query from `lowestPrefixBalance`, verbatim. The overdraft scan; it runs under the account's row lock on every write.
4. **`trial-balance`** — the `accounts LEFT JOIN postings LEFT JOIN entries` aggregate from `trialBalance`, for the whole book.
5. **`postings-page`** — one page from `listPostings`: `WHERE account_id = $1 AND id > $2 ORDER BY id LIMIT 51`.

Take the account id by picking the asset account with the most postings, so the numbers describe the hot case rather than a lucky one:

```sql
SELECT account_id FROM postings GROUP BY account_id ORDER BY count(*) DESC LIMIT 1
```

For each query: run it three times, keep the third plan, and state in the output that the reported plan is warm. A cold first run measures the page cache, not the query.

Capture with `EXPLAIN (ANALYZE, BUFFERS, VERBOSE false, FORMAT TEXT)`.

Print, per query: a `###` heading, the SQL in a `sql` fence, the plan in a `text` fence, and the execution time pulled from the plan's last line.

Index management, as owner:

```sql
-- baseline
DROP INDEX IF EXISTS postings_account_id_id_idx;
DROP INDEX IF EXISTS postings_entry_id_idx;

-- indexed
CREATE INDEX IF NOT EXISTS postings_account_id_id_idx ON postings (account_id, id);
CREATE INDEX IF NOT EXISTS postings_entry_id_idx ON postings (entry_id);
```

Run `ANALYZE postings;` after either, so the planner is not choosing with statistics from the other mode.

- [ ] **Step 2: Add the package script**

```json
    "perf:explain": "node --env-file-if-exists=../../.env --import tsx scripts/explain.ts",
```

- [ ] **Step 3: Take a checkpoint first**

Query 2 needs one to exist. With the seeded book id:

```bash
pnpm --filter @ledger/api checkpoint <bookId>
```

Expected: 200 lines, one per account, all `written`.

- [ ] **Step 4: Capture the baseline**

```bash
pnpm --filter @ledger/api perf:explain --book <bookId> --mode baseline > /tmp/baseline.md
```

Expected: five sections. `balance-from-zero` and `lowest-prefix` should both show a sequential scan over all 500,000 postings — that is the finding, not a failure.

- [ ] **Step 5: Commit the harness**

```bash
git add apps/api/scripts/explain.ts apps/api/package.json
git commit -m "perf(explain): capture the plans as ledger_app sees them, with the policy on"
```

---

### Task 3: The indexes

**Files:**
- Create: `apps/api/drizzle/0009_indexes.sql`
- Modify: `apps/api/src/db/schema.ts`, `apps/api/drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: nothing new.
- Produces: indexes `postings_account_id_id_idx` and `postings_entry_id_idx`, matching the names `explain.ts` creates and drops.

- [ ] **Step 1: Write the migration**

Create `apps/api/drizzle/0009_indexes.sql`. The header comment carries the measurement — quote the actual numbers from Task 2's captures, not placeholders:

```sql
-- The two indexes stage 1 deferred until they could be measured.
--
-- `postings (account_id, id)` is not primarily a read-path index, and the comment in
-- schema.ts that once called it one was wrong. Its hottest consumer is the overdraft prefix
-- scan, which runs inside the entry-insert critical section with the account's row lock
-- held, and then again in the deferred trigger at COMMIT. Both were sequential scans of
-- every posting in the table. See docs/performance.md for the plans either side.
--
-- `postings (entry_id)` serves reading an entry's legs.

CREATE INDEX postings_account_id_id_idx ON postings ("account_id", "id");--> statement-breakpoint
CREATE INDEX postings_entry_id_idx ON postings ("entry_id");
```

Journal entry, appended by hand:

```json
    {
      "idx": 9,
      "version": "7",
      "when": 1786000100000,
      "tag": "0009_indexes",
      "breakpoints": true
    }
```

- [ ] **Step 2: Declare them in the schema**

In `apps/api/src/db/schema.ts`, in the `postings` table's extras array, replace the long "deliberately no index" comment with the two `index()` declarations and a comment that states what was measured — the numbers, not the intention.

```ts
    index('postings_account_id_id_idx').on(t.accountId, t.id),
    index('postings_entry_id_idx').on(t.entryId),
```

- [ ] **Step 3: Apply and capture the indexed plans**

```bash
pnpm db:migrate
```

```bash
pnpm --filter @ledger/api perf:explain --book <bookId> --mode indexed > /tmp/indexed.md
```

Expected: `balance-from-zero`, `balance-from-checkpoint` and `postings-page` switch to index scans. `trial-balance` may not change at all — it aggregates every posting in the book, and there is no index that makes reading everything cheaper.

- [ ] **Step 4: Drop an index that bought nothing**

Compare the two captures per query. If `postings_entry_id_idx` shows no improvement on any of the five, remove it from the migration and from the schema, and record the null result in `docs/performance.md` instead. An index nobody measured a use for is a write cost with a story attached.

- [ ] **Step 5: Run the suite**

```bash
pnpm --filter @ledger/api test
```

Expected: PASS. The Testcontainers suites migrate through `0009` too, so a malformed migration fails here.

- [ ] **Step 6: Commit**

```bash
git add apps/api/drizzle/0009_indexes.sql apps/api/drizzle/meta/_journal.json apps/api/src/db/schema.ts
git commit -m "perf(postings): index (account_id, id), and say what it was measured to buy"
```

---

### Task 4: The document

**Files:**
- Create: `docs/performance.md`

**Interfaces:**
- Consumes: `/tmp/baseline.md` and `/tmp/indexed.md` from Tasks 2 and 3.
- Produces: the document plan 3's README links to.

- [ ] **Step 1: Write the frame**

Create `docs/performance.md` with these sections, in this order:

1. **What was measured, and on what.** Postgres version, machine, whether it was a container, `shared_buffers` and `work_mem` if they are not defaults. A plan without its environment is decoration.
2. **The corpus.** Every constant from `seed-perf.ts` — 250,000 entries, 500,000 postings, 100 asset and 100 revenue accounts, a three-year span, one entry in ten backdated by up to 180 days, `setseed(0.42)` — plus the command to rebuild it and the time it took.
3. **How the plans were taken.** As `ledger_app`, inside a book-scoped transaction, so the row-level security predicate is included. Third run of three, warm. `EXPLAIN (ANALYZE, BUFFERS)`.
4. **The five queries**, one `##` section each, with the SQL, the baseline plan, the indexed plan, and two or three sentences reading them: what the planner chose, what changed, and why.
5. **A summary table** — query, baseline ms, indexed ms, factor.
6. **What did not improve**, and why that is expected. The trial balance aggregates the whole book. Whatever else came out flat goes here with its number.
7. **What this does not fix.** The overdraft scan is faster and still O(account history) under a row lock; the checkpoint does not help it, and `docs/limitations.md` says so.
8. **Reproducing it.** The four commands, in order.

- [ ] **Step 2: Paste the plans**

Copy the captured sections in verbatim. Do not reformat, trim or elide a plan — the `Buffers:` and `actual time` lines are the evidence.

- [ ] **Step 3: Check the arithmetic**

Every factor in the summary table divides two numbers that appear in the pasted plans. Recompute each one by hand. A rounded claim that does not match its own evidence is the one error a reader will find.

- [ ] **Step 4: Commit**

```bash
git add docs/performance.md
git commit -m "docs(performance): the plans either side of the indexes, and what they cost"
```

---

## Done when

- `pnpm --filter @ledger/api perf:seed` builds 500,000 postings from constants and a seeded RNG, and fails loudly if any of the three verification queries finds a violation.
- `pnpm --filter @ledger/api perf:explain` captures plans as `ledger_app` with the book context set, in both modes.
- `docs/performance.md` holds baseline and indexed plans for all five queries, with the environment, the corpus parameters, a summary table whose arithmetic checks out, and a section on what did not improve.
- Migration `0009` adds only indexes justified by a plan in that document.
- The comment in `schema.ts` that deferred these indexes to stage 7 now states what was measured.
- `pnpm test` is clean.
