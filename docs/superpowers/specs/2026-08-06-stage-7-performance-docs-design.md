# Stage 7 — performance, and the written record

Two things that only look like one stage. Half of it is measured work on the read path:
seed the database until the naive queries hurt, show the plans, add the indexes, and add a
balance checkpoint that a backdated entry cannot invalidate. The other half is the record —
README, ADRs, limitations, a generated OpenAPI spec, and CI — which is what makes the first
half legible to anyone who did not write it.

## Goals

1. 500,000 postings in a seeded database, and `EXPLAIN ANALYZE` for the balance queries
   before and after the indexes, both pasted into `docs/performance.md`.
2. A balance checkpoint keyed on **posting id**, with the read path resuming from it, and a
   test asserting the checkpoint path and the sum-from-zero path always agree.
3. A `README.md` whose opening is true, with a **Decisions & Tradeoffs** section.
4. Five ADRs, one of them a decision where the boring option won.
5. `docs/limitations.md` — what is actually missing, stated plainly.
6. An OpenAPI 3.1 spec generated from the Zod schemas, served at `/docs`.
7. GitHub Actions running typecheck, lint and test on every push.

## Non-goals

- Making the write path faster. The overdraft prefix scan runs under the account's row lock
  and is the hottest thing in the system, and nothing in this stage speeds it up. Stage 4's
  ADR explains why; this stage adds `postings(account_id, id)`, which helps that scan find
  its rows, and measures it — but the algorithm is unchanged.
- The frontend. `apps/web` is still a stub; stage 6 shipped the shared contract and the
  three reads it needs, not the screens. This is named in `docs/limitations.md` rather than
  quietly fixed.
- Bitemporal queries. `asOf` continues to filter on `occurred_at` only.
- Deployment. CI verifies; it does not ship.

## Decisions

1. **Checkpoints are written by an explicit maintenance call**, never by the write path and
   never lazily on read. The entry-insert critical section already holds the hottest lock in
   the system and stage 4's ADR is about keeping it narrow. A read path that writes would
   also need INSERT privilege on a path that today needs only SELECT. The cost — nothing
   schedules the refresh — goes in `docs/limitations.md`.
2. **The checkpoint serves `GET /accounts/:id/balance` without `asOf`, and the pagination
   cursor's opening balance.** Both are already keyed on posting id, so the checkpoint is
   sound with no reinterpretation. `asOf` reads and `trialBalance` filter on `occurred_at`
   and keep the naive sum.
3. **`balance_checkpoints` is append-only**, primary key `(account_id, through_id)`, read by
   taking the highest `through_id`. Matches the stance entries and postings already take: a
   superseded checkpoint stays as evidence rather than being silently rewritten.
4. **The seed is a script, not a test.** `pnpm perf:seed` and `pnpm perf:explain` produce the
   numbers by hand; CI runs the seed at ~2k postings only, to prove it still executes against
   the current schema. A 500k-row suite on every push buys a regression signal that timing
   thresholds on a shared runner cannot deliver honestly.
5. **The spec is generated from the route registry**, using Zod 4's built-in
   `z.toJSONSchema`. No new dependency, and the JSON Schema dialect matches OpenAPI 3.1
   natively.
6. **`responses.ts` inverts to Zod-first.** The exported interfaces become `z.infer` of
   schemas rather than hand-written shapes. This reopens a decision argued in that file's own
   comment, and the argument still holds — no runtime parse is being added. What changes is
   that the shape now exists as a value, so the spec can describe responses without a second
   declaration that could disagree with the first.
7. **Backfilled ADRs carry the date the decision was made**, from git history, with one line
   saying the record was written retroactively. Backdating the record silently would be the
   single dishonesty in a document set whose point is honesty.

## Order

Three plans, in sequence.

| Plan | Scope | Depends on |
|---|---|---|
| 1 | Balance checkpoints: migration, repository, service, tests | — |
| 2 | Performance: seed, index migration, EXPLAIN harness, `docs/performance.md` | 1 |
| 3 | OpenAPI and `/docs`, README, ADRs, limitations, CI | 2 |

The ordering is deliberate. Plan 1 ships the checkpoint read correct but unindexed; plan 2
measures that exact query before and after `postings(account_id, id)`. The before/after in
`docs/performance.md` is then a real measurement of code that shipped in that state, not a
plan captured with an index temporarily dropped for the screenshot.

---

## Plan 1 — balance checkpoints

### The table

Migration `0008_balance_checkpoints.sql`:

```sql
create table balance_checkpoints (
  account_id    uuid   not null,
  book_id       uuid   not null,
  through_id    bigint not null,
  balance_minor bigint not null,
  computed_at   timestamptz not null default now(),
  primary key (account_id, through_id),
  foreign key (account_id, book_id) references accounts (id, book_id)
);
```

- `book_id` is denormalised from `accounts`, exactly as `postings.book_id` is, and for the
  same reason: the row-level security policy stays a column comparison instead of a
  correlated subquery. The composite foreign key to `(accounts.id, accounts.book_id)` makes
  disagreement physically impossible.
- RLS enabled, with the book-scoped policy the other tables use. The runtime role gets SELECT
  and INSERT; UPDATE and DELETE are revoked.
- No secondary index. "The latest checkpoint for this account" is
  `order by through_id desc limit 1`, which is a backwards scan of the primary key.

### Writing one

`LedgerService.checkpointAccount(accountId)`, driven by a script
(`pnpm --filter @ledger/api checkpoint`), reading through a repository method:

```sql
select coalesce(max(id), 0)            as through_id,
       coalesce(sum(amount_minor), 0)  as balance_minor
from postings
where account_id = $1
```

One statement, so the watermark and the sum come from a single snapshot. Computing them in
two statements would let a concurrent insert land between them, producing a checkpoint short
by exactly that posting — a wrong number that every later read would inherit. The insert is
`on conflict (account_id, through_id) do nothing`: recomputing at an unchanged watermark
yields the same balance, so a repeated refresh is a no-op rather than an error.

### Reading through one

```
balance(accountId):
  cp = latest checkpoint for accountId          -- order by through_id desc limit 1
  if cp is null: sumPostings(accountId)         -- unchanged, sum from zero
  else:          cp.balance_minor + sum(amount_minor where account_id = a and id > cp.through_id)
```

`sumPostingsThrough(accountId, afterId)` — the pagination cursor's opening balance — resumes
the same way when `afterId >= cp.through_id`, and falls back to the sum from zero when the
cursor points behind the checkpoint.

Both fast paths need `postings(account_id, id)` to be worth anything. That index is plan 2's,
and its absence here is the baseline plan 2 measures.

### Why the key is a posting id and not a date

This argument goes in a comment on the table and in ADR 0005.

A checkpoint asserts *the sum over postings with `id <= N`*. `postings.id` is a bigserial
assigned at insert time, so an entry backdated in `occurred_at` still receives ids greater
than every posting already stored. The set `{id <= N}` is therefore frozen at the moment the
checkpoint is written: no future insert can enter it, and no future insert can change the
number.

A date-keyed checkpoint asserts *the sum over postings with `occurred_at <= D`*. That set is
not frozen. An entry recorded tomorrow, describing a transaction last March, lands inside it.
The stored number is then wrong, and nothing in the row indicates that it is — the checkpoint
looks exactly as valid as it did the day it was written. Invalidating it correctly requires
comparing every entry's `recorded_at` against every checkpoint's date, which is bitemporal
bookkeeping and a different system than this one.

The same asymmetry is why the checkpoint cannot serve `asOf` reads or `trialBalance`: both
filter on `occurred_at`, and the checkpoint knows nothing about the occurred_at distribution
of the postings it summed. It also cannot serve `lowestPrefixBalance`, because a backdated
entry rewrites prefixes that precede any watermark — the minimum over prefixes is not
resumable from a suffix.

### Tests

- A fast-check property, reusing the stage-5 fixture and command generators: random entry
  sequences including backdated `occurred_at`, checkpoints taken at random posting ids, and
  after every command the assertion that the checkpoint path and the sum-from-zero path
  return the same `bigint` — for the account balance and for the cursor's opening balance.
- Two scenarios pinned as named regressions, so a generator change cannot silently stop
  covering them: an entry backdated behind an existing checkpoint, and a reversal recorded
  after one.
- A test that a second `checkpointAccount` at an unchanged watermark inserts nothing and
  changes no answer.
- Privilege tests alongside the existing ones: the runtime role cannot UPDATE or DELETE a
  checkpoint row, and cannot read one belonging to another book.

---

## Plan 2 — performance

### The seed

`apps/api/scripts/seed-perf.ts`: one book, roughly 200 accounts, 250,000 balanced entries of
two legs each — 500,000 postings. `occurred_at` spread over three years, with a documented
share arriving out of order relative to insertion, because a corpus with no backdated entries
would not exercise the distinction this stage is about.

Bulk `insert ... select from generate_series`, run as the owner role with the constraint
triggers disabled for the load and re-enabled afterwards, followed by a verification query
asserting every entry still sums to zero per currency. Firing the deferred balance trigger
and the overdraft trigger 250,000 times would cost minutes to prove something the generator
makes true by construction — so it is checked once, in bulk, instead of assumed.

Parameters (row counts, account count, date range, backdated share, RNG seed) are constants
at the top of the script and are restated in `docs/performance.md`, so the numbers can be
reproduced.

### The measurement

`pnpm perf:explain` takes `--baseline` (drops the stage-7 indexes if present) or `--indexed`
(creates them), and captures `EXPLAIN (ANALYZE, BUFFERS)` for:

1. account balance, sum from zero,
2. account balance, checkpoint plus delta,
3. `lowestPrefixBalance` — the overdraft scan,
4. `trialBalance` for the book,
5. one page of `GET /accounts/:id/postings`.

Both captures are pasted into `docs/performance.md` verbatim, alongside the seed parameters,
the machine, and the Postgres version and relevant settings. Plans without that context are
decoration.

### The indexes

Migration `0009_indexes.sql`: `postings(account_id, id)` and `postings(entry_id)`. Each has to
be justified by a plan in the document. Anything that shows no improvement is dropped from the
migration and the null result is written down — a measured non-improvement is a finding, and
the schema comment that deferred these indexes to "stage 7, where it is measured" is owed an
answer either way.

The schema comment on `postings` that describes these as future work is rewritten to describe
what was measured.

### CI

The seed script runs in CI at ~2,000 postings, asserting only that it completes and that the
verification query passes. It exists to keep the script from rotting against a schema change,
not to measure anything.

---

## Plan 3 — the record

### OpenAPI

`RouteDefinition` gains optional schema fields — `request.{params,query,body}` and
`response` — and the handlers parse through those exact objects rather than through schemas
imported separately. Declared and enforced are then the same value, and a meta-test asserts
every non-public route declares what it parses.

A generator walks the registry and emits OpenAPI 3.1 using `z.toJSONSchema`. Derived rather
than declared twice:

- `security` per operation from `access.kind`: `public` gets none, everything else the
  access-token scheme.
- The `Idempotency-Key` header parameter on exactly the operations for which
  `acceptsIdempotencyKey()` is true.
- Error responses from `access.kind` — 401 where a credential is required, 404 where a book
  is resolved (stage 6's non-member decision), 400 and 422 wherever a schema parses — all
  referencing one `components.schemas.Problem` for the RFC 9457 shape.

`responses.ts` inverts to Zod-first: response shapes become schemas, and the exported
interfaces become `z.infer` of them. No runtime parse is added; the web app's static
guarantee is unchanged. The field-level documentation in that file moves to `.describe()`
calls so it reaches the spec. The decimal-string, id-as-string and ISO-8601 conventions from
`serialize.ts` become shared schemas used everywhere they apply.

`GET /docs` and `GET /docs/openapi.json` are two `access: 'public'` registry rows, so
`routes.meta.test.ts` covers them like any other route and neither can exist without
declaring what it requires. `/docs` is a small HTML page loading Scalar from a CDN, pointed
at the JSON.

The generated spec is committed at `docs/openapi.json`, with a test that regenerates and
diffs it. A route or schema change that skips the spec fails CI.

### README

The opening is currently false — it says stages 1 and 2 are complete and there is no HTTP
layer. It is rewritten against the system that exists. A **Decisions & Tradeoffs** section is
added, each entry naming the decision, the alternative rejected, the cost being carried, and
its ADR.

The long internals move out so the front door is readable: the property-test corpus and query
counting to `docs/testing.md`; the two-connections/two-roles section and the invariant SQL
detail to `docs/database.md`. Nothing is deleted.

### ADRs

| # | Decision | Date |
|---|---|---|
| 0001 | Invariants enforced in the database, not only in application code | from git history |
| 0002 | Money as `bigint` minor units, decimal strings at the boundary | from git history |
| 0003 | Idempotency keys in Postgres, not Redis — **the boring option** | from git history |
| 0004 | Concurrency control for the overdraft rule | exists |
| 0005 | Balance checkpoints keyed on posting id | this stage |

Existing headings: Date, Status, Context, Decision, Consequences. The backfilled three carry
the date the decision was made and a line stating the record was written in stage 7.

0003 is the boring one on purpose: Redis would have been the reflexive answer for an
idempotency cache, and Postgres wins because the reservation has to be transactional with
the write it guards. A second datastore would have meant a cross-store consistency problem
in exchange for latency this system does not need.

### `docs/limitations.md`

Written as a list of things that are missing, each with a sentence on what it would take:

- Checkpoint refresh is manual; nothing schedules it, and a stale checkpoint costs read time
  but never correctness.
- `asOf` balances, `trialBalance` and the overdraft prefix scan get no benefit from
  checkpoints — and the overdraft scan is the one holding a lock.
- `apps/web` is a stub. There is no frontend.
- Responses are typed and specified but never parsed at runtime.
- No rate limiting, no metrics, no tracing.
- Idempotency rows are never pruned.
- No down migrations.
- One currency per account, no FX.
- CI verifies but does not deploy.

### CI

`.github/workflows/ci.yml`, on `push` and `workflow_dispatch`, with a per-ref concurrency
group that cancels superseded runs. Two jobs:

- `static` — Node 22, pnpm with cache, `pnpm typecheck`, `pnpm lint`.
- `test` — same setup, `pnpm test` against the runner's Docker daemon for Testcontainers,
  then the perf seed smoke at ~2k postings.

Split because typecheck and lint fail in under a minute and should not queue behind a
container-backed suite.

## Files

New:

- `apps/api/drizzle/0008_balance_checkpoints.sql`, `0009_indexes.sql`
- `apps/api/scripts/seed-perf.ts`, `apps/api/scripts/explain.ts`, `apps/api/scripts/checkpoint.ts`
- `apps/api/src/openapi/generate.ts`, `apps/api/src/routes/docs.routes.ts`
- `apps/api/tests/properties/checkpoint.property.test.ts`, `apps/api/tests/db/checkpoints.test.ts`,
  `apps/api/tests/http/openapi.test.ts`
- `docs/performance.md`, `docs/limitations.md`, `docs/testing.md`, `docs/database.md`,
  `docs/openapi.json`
- `docs/adr/0001-invariants-in-the-database.md`, `0002-money-as-minor-units.md`,
  `0003-idempotency-in-postgres.md`, `0005-balance-checkpoints.md`
- `.github/workflows/ci.yml`

Changed:

- `apps/api/src/db/schema.ts` — the checkpoint table, and the postings index comment rewritten
  against what was measured
- `apps/api/src/repositories/ledger.repository.ts` — checkpoint read and write, delta sums
- `apps/api/src/services/ledger.service.ts` — `balance` and the cursor opening balance resume
  from a checkpoint; `checkpointAccount`
- `apps/api/src/routes/registry.ts` — schema fields on `RouteDefinition`
- `apps/api/src/routes/*.routes.ts` — handlers parse through the row's schemas
- `packages/shared/src/contracts/responses.ts` — Zod-first
- `README.md`

## Done when

- `docs/performance.md` holds both plans for all five queries, with seed parameters and
  machine stated, and every index in `0009` is justified by one of them.
- The property test and both named regressions pass: the checkpoint path and the
  sum-from-zero path agree, including behind a backdated entry and a reversal.
- `GET /docs` renders, `GET /docs/openapi.json` validates as OpenAPI 3.1, and the drift test
  fails when a route or schema changes without regenerating.
- The README's opening is true and its Decisions & Tradeoffs section links five ADRs.
- `docs/limitations.md` names the frontend gap and the unscheduled checkpoint refresh.
- The workflow is green on a push, running typecheck, lint and test.
