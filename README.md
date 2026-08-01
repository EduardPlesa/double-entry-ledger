# Double-entry ledger

A double-entry accounting ledger. Portfolio project: not deployed anywhere, but built to
production standards.

Stages 1 and 2 are complete: the schema and the invariants the *database* enforces, then
the config module and the ledger service. There is no HTTP layer yet — that is stage 3.

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
cannot express invariant 1.

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

## Layout

```
apps/api/src/config.ts          the only place process.env is read
apps/api/src/services           business rules: no Express, no SQL
apps/api/src/repositories       data access: no business rules
apps/api/src/db                 pool, transactions, schema, migrations
apps/api/src/composition.ts     the one place interfaces meet implementations
apps/web                        stage 6
packages/shared                 Money, Clock, ids — both sides import these
docker/initdb                   cluster bootstrap: role creation and credentials
```

## The service layer

`postEntry` validates the zero-sum rule in application code *as well as* in the database, so
the common authoring mistake fails before a transaction is opened and with an error naming
the currency and the amount. The database's deferred trigger remains the enforcement that
matters: it binds every writer, including a future version of this service with a bug in it.

`getBalance` sums postings from zero, every time. It is naive and correct by construction —
nothing can drift from a value that is never stored. `asOf` filters on `occurred_at`, when
the transaction happened in the world, so a backdated entry changes the answer to a question
about last March. Stage 7 adds checkpoints keyed on posting id, and a test asserting the two
paths always agree.

`listPostings` pages by posting id — a bigserial, so a keyset cursor needs no tiebreaker and
cannot skip or repeat a row — and carries a running balance across pages, in a fixed number
of queries per page regardless of page size.

Posting the same `external_id` twice returns the entry already recorded, rather than a
duplicate or a conflict. The race between two concurrent posts of one `external_id` is
resolved by the unique index and recovered from by re-reading the winner's row; a test fires
three at once.

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
takes `SELECT ... FOR NO KEY UPDATE` on the accounts an entry draws from, so writers block;
`serializable` drops the explicit locks, runs the transaction at `SERIALIZABLE` and retries
on `40001`, so writers abort and try again. Both enforce the rule exactly and admit the same
number of concurrent withdrawals; they differ in what the losers are told, which is the whole
argument of `docs/adr/0004-concurrency-control.md`.

## Two connections, two roles

`ledger_owner` owns the schema and is used only by the migration CLI.
`ledger_app` is the runtime role: `SELECT` and `INSERT` on `entries` and `postings`, with
`UPDATE`, `DELETE` and `TRUNCATE` revoked. The application never holds a connection capable
of rewriting history. Keeping the two apart is what makes the revoke meaningful — a role
that could migrate could also grant itself back what it lost.
