# 1. The invariants live in the database

Date: 2026-07-30
Status: accepted

Written in stage 7, after the fact. The decision was taken when migrations `0002`, `0003` and
`0006` were written; this record is a reconstruction of the argument those files already make
in their comments, not a contemporaneous note.

## Context

Four rules define this ledger, and none of them are negotiable:

1. Every entry's postings sum to exactly zero, per currency.
2. Entries and postings are append-only. Corrections are reversing entries, never edits.
3. A guarded account may not be negative at any point in its history.
4. A book's rows are reachable only from that book.

The question is not whether to enforce them - it is where. The application is the obvious
place, and it is also the place that can be bypassed. A `psql` session bypasses it. A
migration bypasses it. A second service written later against the same database bypasses it,
and so does a script somebody runs once at two in the morning. A bug in this codebase bypasses
it while looking exactly like working code. Every one of those is ordinary; none of them
requires anybody to be careless.

The cost of that class of failure is unusual here. Because history is append-only, a violation
cannot be edited out afterwards. A single unbalanced entry that commits is permanent, and the
correction is another entry describing the mistake - which means the record shows both what
was wrong and that the system allowed it.

## Decision

Every one of the four is enforced by Postgres, and the service enforces them again where it
can produce a better error.

**Invariant 1 - entries balance.** A `DEFERRABLE INITIALLY DEFERRED` constraint trigger
(`LG001`, `0003_invariants.sql`), running `sum(amount_minor) group by currency` at COMMIT. A
`CHECK` cannot express it, for two independent reasons the migration states: a `CHECK` sees one
row and this is a property of the set of rows sharing an `entry_id`, and `CHECK` constraints
are not deferrable, while this invariant is legitimately false between the first leg's insert
and the last one's. A constraint trigger is the only form Postgres allows to be deferred, which
also forces it to be `AFTER` and `FOR EACH ROW`. `LG003` closes the hole a zero-leg entry would
otherwise walk through: a trigger that fires on posting inserts never examines an entry with no
postings, so an empty entry would commit as vacuously balanced.

**Invariant 2 - append-only.** Enforced twice, deliberately. `0002_privileges.sql` grants
`ledger_app` only `SELECT, INSERT` on `entries` and `postings`, and revokes
`UPDATE, DELETE, TRUNCATE` explicitly - redundantly, so that a later migration widening the
grant has to widen it past a line that says what it is undoing. `0003_invariants.sql` adds
`LG002`, a `BEFORE UPDATE OR DELETE` trigger that binds every role including the owner, plus a
statement-level `BEFORE TRUNCATE` trigger, because `TRUNCATE` is not a `DELETE` and row-level
triggers never see it. The two are not redundant. A missing grant is invisible to anyone
reading the schema and evaporates the moment a later migration widens it; the trigger fails
loudly and names the rule. Only a role that can `DROP` the trigger gets past it, which is the
level of deliberateness the operation deserves.

**Invariant 3 - no overdraft.** A constraint trigger (`LG004`, `0007_overdraft.sql`) running the
same prefix query the service runs. `docs/adr/0004-concurrency-control.md` is about this one in
full, including the part this ADR would otherwise overstate: the trigger is not what makes the
rule safe under concurrency, and a row lock is.

**Invariant 4 - isolation.** Row-level security (`0006_row_level_security.sql`), with the book
in a `SET LOCAL` the unit of work issues. Application-side `WHERE book_id = ...` is still
written everywhere it belongs; RLS is what makes forgetting one a failed query rather than a
data leak.

## Consequences

- **Errors arrive as SQLSTATEs, and something has to translate them.** `db/pg-errors.ts` reads
  the code off the driver's error and maps `LG001`-`LG004` and the standard `23505`/`23503`
  onto domain errors. It has to dig for it: drizzle throws its own error with the driver's as
  `cause`, so a check against the top-level error finds no SQLSTATE and every constraint
  violation reads as an unrecognised failure - a 500 where a 409 belongs. That is a failure
  mode with no symptom in a unit test built from a hand-made error object; an integration test
  against a real duplicate insert is what found it.
- **The test suite needs a real Postgres.** None of this is testable against a fake. The
  integration, concurrency and property suites all start a container through Testcontainers,
  which means Docker has to be running and the first assertion is about seven seconds away.
  `vitest.config.ts` splits the projects so that checking a regex does not pay for a container,
  and the split exists precisely because a suite you cannot run is a suite that stops being run.
- **A deferred check reports at COMMIT, which is further from the cause than an immediate one.**
  The service checks first wherever it can, so the common failures carry the field, the amount
  and the account that caused them. The database's answer is the backstop, and it is
  deliberately terser: `LG004` knows an account is short but not which one, because the trigger
  sees one posting at a time.
- **`FOR EACH ROW` runs the balance check once per leg of an entry.** Each run reaches the same
  verdict about the same set. That is wasted work and it is unavoidable - a constraint trigger
  cannot be `FOR EACH STATEMENT` - and it is bounded by the number of legs, which is a handful.
- **The rules cannot be turned off by a deploy.** That is the whole point, and it cuts both
  ways: changing one means a migration, review, and a database that is briefly running the old
  rule and the new code or the reverse. This is a system where that friction is worth paying
  for.
