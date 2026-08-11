# Double-entry ledger

A double-entry accounting ledger with an HTTP API and a web frontend. Portfolio project: not
deployed anywhere, but built to production standards.

What is here: books and accounts, balanced entries, reversals, balances and a trial balance,
paged postings with a running balance. Cookie sessions and API keys, role-based authorization,
row-level security per book. Idempotent writes behind `Idempotency-Key`. An overdraft rule
enforced over *every prefix* of a guarded account's history, not merely its final balance.
Balance checkpoints so a balance does not have to be re-derived from the first posting every
time. An OpenAPI 3.1 document generated from the same schemas the handlers parse, served at
`/docs`.

What is not here is in [docs/limitations.md](docs/limitations.md), stated plainly.

## Invariants

1. Every entry's postings sum to exactly zero, per currency.
2. Entries and postings are append-only. No UPDATE, no DELETE, ever. Corrections happen
   only via reversing entries.
3. Money is `bigint` minor units. Never a float, never a JS `number`.
4. Account balances are derived from postings, never stored as a mutable column of truth.
5. Invariants 1 and 2 are enforced in the database, not only in application code.

Invariant 1 lives in a deferred constraint trigger; invariant 2 lives in both a `REVOKE`
against the runtime role and a trigger that binds even the schema owner. See
[`0003_invariants.sql`](apps/api/drizzle/0003_invariants.sql) for why a `CHECK` constraint
cannot express invariant 1, and [docs/database.md](docs/database.md) for the rest of the schema.

## Decisions & tradeoffs

Each of these has an ADR. The short version is here; the argument, the alternative that was
rejected and the cost being carried are there.

**The invariants live in the database.** Constraint triggers, revoked privileges and row-level
security rather than application checks alone. The alternative — enforcing them in the service —
is bypassed by a `psql` session, a migration, a second service or a bug. It costs a test suite
that needs Docker, and errors that arrive as SQLSTATEs needing translation.
[ADR 0001](docs/adr/0001-invariants-in-the-database.md)

**Money is a `bigint` in minor units, a decimal string on the wire.** Not a float, which cannot
represent money, and not a JSON number, whose 53 bits of mantissa cannot hold every value this
ledger can. It costs a `::text` cast on every SQL aggregate and an explicit serializer per
resource, because JSON has no bigint. [ADR 0002](docs/adr/0002-money-as-minor-units.md)

**Idempotency keys live in Postgres, not Redis.** The boring option. Redis would have brought a
free TTL and one round trip; it also brings a second datastore whose "this call succeeded" can
disagree with the ledger's "this entry exists". It costs rows nobody prunes and contention on the
same database as the write. [ADR 0003](docs/adr/0003-idempotency-in-postgres.md)

**Row locks, not `SERIALIZABLE`, for the overdraft rule.** The prefix rule reads an account's
whole posting range, which is the shape SSI handles worst: measured, every contested writer
aborted to the retry cap and got a serialization failure instead of the 422 the domain has an
answer for. Row locks turn the same contention into waiting. It costs a lock held across a scan
that grows with the ledger. [ADR 0004](docs/adr/0004-concurrency-control.md)

**Balance checkpoints keyed on posting id, refreshed by hand.** A date key would be wrong the
first time somebody backdates an entry. The watermark is only sound because every write locks
every account it touches — which is what this decision cost the write path. Nothing schedules the
refresh, and a stale checkpoint is slower rather than wrong.
[ADR 0005](docs/adr/0005-balance-checkpoints.md)

Two more shape the codebase without an ADR of their own:

**The route registry is the only place a route can exist.** `apps/api/src/routes/registry.ts`
is a table of every route with its access requirement, its schemas and its handler; `http/app.ts`
walks it and nothing else. A route that is not in it is not served, and a meta-test compares the
table against what Express actually registered, in both directions. The same rows are what the
OpenAPI document is generated from, so the published spec cannot describe a route that does not
exist or omit one that does.

**Balances are derived, never stored.** There is no balance column to drift from the postings.
Checkpoints are a resumption point with an always-correct sum-from-zero path retained beside
them, and a property test asserts the two agree over arbitrary histories.

## Running it

Requires Node 22+, pnpm, and a running Docker daemon.

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
pnpm db:up
```

```bash
pnpm db:migrate
```

The integration tests do not use that database. They start their own Postgres 16 via
Testcontainers, provisioned from the same `docker/initdb` bootstrap, and migrate it through
the same code path:

```bash
pnpm test
```

```bash
pnpm typecheck
```

```bash
pnpm lint
```

Developing the frontend against a live API means two long-running processes, not one:
`pnpm --filter @ledger/api dev` and `pnpm --filter @ledger/web dev`. They stay separate rather
than one script starting both, because their failure modes are different enough that
interleaved logs would hide which one to look at. Vite's dev server proxies each API path to
the API process, and it forwards them verbatim - no `/api` prefix, no rewrite. That is load-
bearing, not tidiness: the refresh cookie is set with `Path=/auth`, so a browser only attaches
it to requests whose path starts with `/auth`. Prefix that with `/api` and the cookie still
gets set on login, but the browser silently withholds it from `/api/auth/refresh` on the next
request - every session dies at its first refresh, with nothing in the response to say why.
Same-origin proxying also keeps the cookie's `sameSite=lax` doing the job it was chosen for.

The browser end-to-end test needs the compose database rather than Testcontainers, since there
the connection belongs to the API process the browser talks to, not to the test process:

```bash
pnpm db:up && pnpm db:migrate
```

```bash
pnpm --filter @ledger/web e2e
```

That command starts both the API and the web dev server itself.

Four scripts are for the parts of the system that are not a request:

```bash
pnpm --filter @ledger/api openapi
```

```bash
pnpm --filter @ledger/api checkpoint <bookId>
```

```bash
pnpm --filter @ledger/api perf:seed --postings 500000
```

```bash
pnpm --filter @ledger/api perf:explain
```

`openapi` regenerates [docs/openapi.json](docs/openapi.json), which a test compares against what
the running application would serve. `checkpoint` refreshes every checkpoint in a book — nothing
else does. `perf:seed` and `perf:explain` are how the numbers in
[docs/performance.md](docs/performance.md) were taken.

The API serves the same document at `/docs/openapi.json`, and `/docs` renders it as a page.

## Where things are documented

- [docs/database.md](docs/database.md) — the schema, the two roles, and where each invariant is
  enforced.
- [docs/testing.md](docs/testing.md) — the four test projects, the property suite and what it
  found, query counting, the contract and route meta-tests.
- [docs/performance.md](docs/performance.md) — `EXPLAIN ANALYZE` at 500,000 postings, either side
  of the index migration, including the query the index makes slower.
- [docs/limitations.md](docs/limitations.md) — what is missing, what it costs, what fixing it
  would take.
- [docs/adr/](docs/adr/) — the five decisions above, in full.
- [docs/openapi.json](docs/openapi.json), or `/docs` on a running server — the API.

## Layout

```
apps/api/src/config.ts          the only place process.env is read
apps/api/src/routes/registry.ts the table every route has to be in
apps/api/src/services           business rules: no Express, no SQL
apps/api/src/repositories       data access: no business rules
apps/api/src/openapi            the document, generated from the registry
apps/api/src/db                 pool, transactions, schema, migrations
apps/api/src/composition.ts     the one place interfaces meet implementations
apps/web                        the SPA: session, accounts, the composer, the reports
packages/shared                 Money, Clock, ids, and both halves of the contract
docker/initdb                   cluster bootstrap: role creation and credentials
```

## The service layer

`postEntry` validates the zero-sum rule in application code *as well as* in the database, so
the common authoring mistake fails before a transaction is opened and with an error naming
the currency and the amount. The database's deferred trigger remains the enforcement that
matters: it binds every writer, including a future version of this service with a bug in it.

`getBalance` resumes from a checkpoint where one exists and helps, and sums from zero otherwise.
The sum-from-zero path is naive and correct by construction — nothing can drift from a value that
is never stored — and it is retained precisely so the checkpoint has something to be checked
against. `asOf` filters on `occurred_at`, when the transaction happened in the world, so a
backdated entry changes the answer to a question about last March; a checkpoint cannot help
there, because it carries no information about the dates of the postings it summed.

`listPostings` pages by posting id — a bigserial, so a keyset cursor needs no tiebreaker and
cannot skip or repeat a row — and carries a running balance across pages, in a fixed number
of queries per page regardless of page size.

Posting the same `external_id` twice returns the entry already recorded, rather than a
duplicate or a conflict. The race between two concurrent posts of one `external_id` is
resolved by the unique index and recovered from by re-reading the winner's row; a test fires
three at once.

The request schemas that validate `postEntry` and its neighbours, and the response schemas
`apps/api/src/http/serialize.ts` produces values for, live in `packages/shared`. The frontend
gates its submit button on the same zero-sum rule this service enforces, and it needs to ask that
question before a request round-trips to the server. Two copies of that rule, one in each app,
would eventually disagree — and the direction they'd disagree in is the frontend offering a
button whose submission the service was always going to reject. The same schemas are what the
OpenAPI document publishes.

## Money, and the boundary

Amounts are `bigint` minor units everywhere inside the system. They cross the service
boundary as decimal *strings* — `"12.34"`, never a JSON number, whose 53 bits of mantissa
cannot hold every value this ledger can. `packages/shared/src/money.ts` owns the conversion
and the per-currency scale (JPY has no minor unit, KWD has three), so neither side has to
know it. More decimal places than the currency has is an error, not a rounding: the caller is
the only one who knows where a half-cent should go.

Services take a `Clock` and never call `new Date()`, which is what makes `recorded_at` an
assertable value in tests rather than a race.

## Configuration

`apps/api/src/config.ts` is the only module that reads `process.env`. It validates the whole
environment with Zod and throws at boot. An ESLint rule (`no-restricted-properties`) makes
the restriction real everywhere else; `pnpm lint` fails on `process.env` outside that file
and the drizzle-kit config, which runs in its own process.

The `.env` file is loaded by Node's `--env-file-if-exists`, not by a library, so importing
the config module has no side effects and a real environment variable always wins over the
file. `.env.example` lists every variable that is read, with the optional ones commented out
at their defaults.

`LEDGER_CONCURRENCY_STRATEGY` is the one worth knowing about here. It selects how the
overdraft rule is kept true when two writers meet — `row-lock` (the default, and what ships)
takes `SELECT ... FOR NO KEY UPDATE` on the accounts an entry touches, so writers block;
`serializable` drops the explicit locks, runs the transaction at `SERIALIZABLE` and retries
on `40001`, so writers abort and try again. Both enforce the rule exactly and admit the same
number of concurrent withdrawals; they differ in what the losers are told, and that difference
is not merely cosmetic. Nothing translates an exhausted `40001` into a domain error, so under
`serializable` a contested withdrawal that `row-lock` answers with a 422 `ACCOUNT_OVERDRAWN`
instead exhausts `DrizzleUnitOfWork`'s retries and reaches the client as a 500. Balance
checkpoints also refuse to run under `serializable`, for a reason
[ADR 0005](docs/adr/0005-balance-checkpoints.md) argues in full. That is why `row-lock` ships as
the default; the measurement that decided it is in
[ADR 0004](docs/adr/0004-concurrency-control.md).
