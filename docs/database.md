# The database

Postgres 16, reached through two roles, with the ledger's rules enforced in the schema rather
than only in the application. [ADR 0001](adr/0001-invariants-in-the-database.md) argues why;
this file describes what is actually there.

## Two connections, two roles

`ledger_owner` owns the schema and is used only by the migration CLI.

`ledger_app` is the runtime role: `SELECT` and `INSERT` on `entries` and `postings`, with
`UPDATE`, `DELETE` and `TRUNCATE` revoked. The application never holds a connection capable of
rewriting history. Keeping the two apart is what makes the revoke meaningful — a role that could
migrate could also grant itself back what it lost.

`ledger_app` has no `DELETE` on anything at all, which is deliberate and has a consequence:
expired refresh tokens and completed idempotency reservations accumulate, and nothing prunes
them. See [limitations.md](limitations.md).

## The invariants, and where each one lives

**1. Every entry's postings sum to zero, per currency.** A `DEFERRABLE INITIALLY DEFERRED`
constraint trigger raising `LG001`, in [`0003_invariants.sql`](../apps/api/drizzle/0003_invariants.sql).
A `CHECK` cannot express it for two independent reasons: a `CHECK` sees one row and this is a
property of the set of rows sharing an `entry_id`, and `CHECK` constraints are not deferrable —
while this invariant is legitimately false between the first leg's insert and the last one's. A
constraint trigger is the only deferrable form, which forces it to be `AFTER` and `FOR EACH ROW`,
so an n-leg entry runs the same aggregate n times. That is wasted work, bounded by the number of
legs, and unavoidable.

`LG003` closes the hole beside it: a trigger that fires on posting inserts never examines an
entry that has no postings, so an empty entry would otherwise commit as vacuously balanced.

Both functions are `SECURITY DEFINER` with a pinned `search_path`. Under row-level security a
`SECURITY INVOKER` function would aggregate only the rows the current role may see, and an entry
could balance under RLS while being unbalanced in fact.

**2. Entries and postings are append-only.** Enforced twice: `0002_privileges.sql` grants
`ledger_app` only `SELECT, INSERT` and revokes the rest explicitly; `0003_invariants.sql` adds
`LG002`, a `BEFORE UPDATE OR DELETE` trigger binding every role including the owner, plus a
statement-level `BEFORE TRUNCATE` trigger — `TRUNCATE` is not a `DELETE` and row-level triggers
never see it. The grant is invisible to anyone reading the schema and evaporates when a later
migration widens it; the trigger fails loudly and names the rule.

**3. A guarded account is never negative at any point in its history.** `LG004`, a constraint
trigger in [`0007_overdraft.sql`](../apps/api/drizzle/0007_overdraft.sql), running the same
prefix query the service runs. The trigger is not what makes the rule safe under concurrency — a
row lock is, and [ADR 0004](adr/0004-concurrency-control.md) is about exactly that.

**4. A book's rows are reachable only from that book.** Row-level security in
[`0006_row_level_security.sql`](../apps/api/drizzle/0006_row_level_security.sql), with the book
id in a `SET LOCAL` the unit of work issues before anything else runs. The application still
writes `where book_id = ...` everywhere it belongs; RLS is what turns forgetting one into an
empty result rather than a data leak.

## Reading the database's answers

Every one of those raises a SQLSTATE, and `apps/api/src/db/pg-errors.ts` is where they become
domain errors. It digs through `cause` to find them: drizzle throws its own error with the
driver's underneath, so a check against the top-level error finds no SQLSTATE at all and every
constraint violation reads as an unrecognised failure — a 500 where a 409 belongs.

## Balances are derived

There is no balance column. `getBalance` sums an account's postings, and
[ADR 0005](adr/0005-balance-checkpoints.md) describes the checkpoint that lets it resume from a
watermark instead of from zero — which is a cache with an independent, always-correct answer
beside it, not a stored balance.

## Migrations

Forward only, in `apps/api/drizzle/`, applied by `pnpm db:migrate` through the same code path
the tests use. There are no down migrations; rolling back means restoring a database.
