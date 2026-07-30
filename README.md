# Double-entry ledger

A double-entry accounting ledger. Portfolio project: not deployed anywhere, but built to
production standards.

Stage 1 of the build is complete: the schema, and the invariants the *database* enforces.
There is no application code yet beyond what the integration tests need.

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

## Layout

```
apps/api            schema, migrations, integration tests
apps/web            stage 6
packages/shared     code both sides need (ids now, Money next)
docker/initdb       cluster bootstrap: role creation and credentials
```

## Two connections, two roles

`ledger_owner` owns the schema and is used only by the migration CLI.
`ledger_app` is the runtime role: `SELECT` and `INSERT` on `entries` and `postings`, with
`UPDATE`, `DELETE` and `TRUNCATE` revoked. The application never holds a connection capable
of rewriting history. Keeping the two apart is what makes the revoke meaningful — a role
that could migrate could also grant itself back what it lost.
