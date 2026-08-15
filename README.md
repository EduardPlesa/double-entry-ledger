# Double-entry ledger

A double-entry accounting ledger with an HTTP API and a web frontend. TypeScript, Postgres,
Express, React. A portfolio project, not deployed anywhere.

- **Books, accounts, entries, reversals** — with balances, a trial balance, and postings paged
  by keyset cursor with a running balance.
- **Every entry balances, and the database is what enforces it** — a deferred constraint
  trigger, not an application check that a `psql` session can walk around.
- **History is append-only.** No UPDATE, no DELETE, at any privilege level. Corrections are
  reversing entries.
- **An overdraft rule over *every prefix* of an account's history**, not merely its final
  balance — so a backdated withdrawal that overdrew the account in March is refused today.
- **Cookie sessions and API keys**, role-based authorization, and row-level security scoping
  every query to one book.
- **Idempotent writes** behind `Idempotency-Key`, reserved in Postgres rather than Redis.
- **Balance checkpoints** keyed on posting id, so a balance resumes from a watermark instead of
  re-summing an account's whole history.
- **An OpenAPI 3.1 document** generated from the same schemas the handlers parse, served at
  `/docs` and committed at [docs/openapi.json](docs/openapi.json).

What is *not* here is in [docs/limitations.md](docs/limitations.md), stated plainly.

## A request

Recording a €1,200 sale — one entry, two legs, summing to zero:

```bash
curl -X POST localhost:3000/books/$BOOK/entries \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 7c2f-invoice-41' \
  -d '{
    "occurredAt": "2026-03-01T12:00:00.000Z",
    "description": "Invoice 41",
    "legs": [
      { "accountId": "'$CASH'",  "amount":  "1200.00", "currency": "EUR" },
      { "accountId": "'$SALES'", "amount": "-1200.00", "currency": "EUR" }
    ]
  }'
```

```http
HTTP/1.1 201 Created
Location: /entries/01a006d0-03a7-761f-a8c5-6af12cb2ebee
X-Request-Id: 01a006d0-03a5-74d5-abab-b9305f6699aa
```

```json
{
  "id": "01a006d0-03a7-761f-a8c5-6af12cb2ebee",
  "bookId": "01a006d0-0279-73e8-b63d-c89a99936899",
  "occurredAt": "2026-03-01T12:00:00.000Z",
  "recordedAt": "2026-08-15T19:04:50.855Z",
  "description": "Invoice 41",
  "externalId": null,
  "reversalOf": null,
  "reversedBy": null,
  "postings": [
    { "id": "23", "accountId": "…02df…", "amount":  "1200.00", "currency": "EUR" },
    { "id": "24", "accountId": "…034c…", "amount": "-1200.00", "currency": "EUR" }
  ]
}
```

Every amount is a decimal string and every posting id is a string, for the same reason: a JSON
number is an IEEE 754 double, and this ledger holds values it could not round-trip. Retrying
that call with the same `Idempotency-Key` returns this response rather than recording a second
sale.

Send legs that do not sum to zero and the answer is an RFC 9457 problem document, with the
amount it is out by:

```json
{
  "type": "https://ledger.local/problems/entry-unbalanced",
  "title": "Entry is unbalanced",
  "status": 422,
  "detail": "entry is unbalanced: EUR legs sum to 100",
  "code": "ENTRY_UNBALANCED",
  "requestId": "01a006cf-d483-730a-bdec-7bf42c11be83"
}
```

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

**1. Install.**

```bash
pnpm install
```

**2. Configure.** `.env.example` lists every variable the application reads; the defaults in it
are development-only and work as they are.

```bash
cp .env.example .env
```

**3. Start Postgres and migrate it.**

```bash
pnpm db:up
```

```bash
pnpm db:migrate
```

**4. Run the API.** It serves on port 3000, with the spec at `/docs`.

```bash
pnpm --filter @ledger/api dev
```

### Checks

The integration tests do not use the database from step 3. They start their own Postgres 16 via
Testcontainers, provisioned from the same `docker/initdb` bootstrap and migrated through the
same code path — so `pnpm test` needs Docker but no configuration.

```bash
pnpm test
```

```bash
pnpm typecheck
```

```bash
pnpm lint
```

### The frontend

Developing the frontend against a live API means two long-running processes, not one:
`pnpm --filter @ledger/api dev` and `pnpm --filter @ledger/web dev`. They stay separate rather
than one script starting both, because their failure modes are different enough that
interleaved logs would hide which one to look at. Vite's dev server proxies each API path to
the API process, and it forwards them verbatim — no `/api` prefix, no rewrite. That is
load-bearing, not tidiness: the refresh cookie is set with `Path=/auth`, so a browser only
attaches it to requests whose path starts with `/auth`. Prefix that with `/api` and the cookie
still gets set on login, but the browser silently withholds it from `/api/auth/refresh` on the
next request — every session dies at its first refresh, with nothing in the response to say why.
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

### The scripts

Four commands are for the parts of the system that are not a request:

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

## A few things worth knowing

**One contract, imported by both sides.** The schemas that validate a request and describe a
response live in `packages/shared`, so the service enforces the zero-sum rule and the composer
greys out its submit button on the same expression. Two copies would eventually disagree, and
the direction they would disagree in is a button whose submission the server was always going
to reject. Those same schemas are what the OpenAPI document publishes.

**Posting the same `external_id` twice returns the entry already recorded**, rather than a
duplicate or a conflict. The race between two concurrent posts of one `external_id` is resolved
by the unique index and recovered from by re-reading the winner's row; a test fires three at
once. That is the ledger-level guarantee, and `Idempotency-Key` is the transport-level one —
they answer different questions, which is why both exist.

**`config.ts` is the only module that reads `process.env`.** It validates the whole environment
with Zod and throws at boot, and an ESLint rule makes the restriction real everywhere else.
`LEDGER_CONCURRENCY_STRATEGY` is the variable worth knowing about: it switches the overdraft
rule between row locks and `SERIALIZABLE`, and [ADR 0004](docs/adr/0004-concurrency-control.md)
is the measurement of why `row-lock` is the default.

**Services take a `Clock` and never call `new Date()`**, which is what makes `recorded_at` an
assertable value in tests rather than a race.
