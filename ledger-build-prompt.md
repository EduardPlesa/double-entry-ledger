# Double-Entry Ledger — Build Prompt

Use this with a coding agent (Claude Code, Cursor, etc.) **one stage at a time**.
Run a stage, review the diff, run the tests, commit, then start the next stage in a
fresh context. Pasting the whole thing at once produces plausible code with the
invariants quietly missing.

---

## Context prompt (paste at the start of every stage)

> You are helping me build a double-entry accounting ledger as a portfolio project
> demonstrating backend engineering depth. It is not for production deployment, but
> it must be production-*quality*.
>
> **Stack:** TypeScript, Node 22, Express 5, PostgreSQL 16, Drizzle ORM, Zod, Vitest,
> Supertest, Testcontainers. pnpm workspace monorepo: `apps/api`, `apps/web`,
> `packages/shared`.
>
> **Non-negotiable invariants.** Never work around these; if a request seems to
> require breaking one, stop and tell me:
>
> 1. Every entry's postings sum to exactly zero per currency.
> 2. Entries and postings are append-only. No UPDATE, no DELETE, ever. Corrections
>    happen only via reversing entries.
> 3. Money is `bigint` minor units. Never a float, never a JS `number` for amounts.
> 4. Account balances are always derived from postings, never stored as a mutable
>    column of truth. Snapshots are a cache, not the source.
> 5. Both invariants 1 and 2 are enforced in the database, not only in application
>    code.
>
> **Architecture:** `routes/` (HTTP only) → `services/` (business rules, no Express,
> no SQL) → `repositories/` (data access, no business rules). Services take
> dependencies as constructor arguments. One composition root wires everything.
> Typed domain errors mapped to HTTP status codes in exactly one error middleware.
>
> **Working style:** Ask before assuming. If a design decision has a real tradeoff,
> present the options with your recommendation and wait for my answer rather than
> silently picking one. Write the test before or alongside the code. Keep commits
> atomic with conventional commit messages.

---

## Stage 1 — Schema and database-enforced invariants

> Set up the monorepo skeleton, Docker Compose with Postgres 16, and Drizzle
> configured for migrations.
>
> Create two database roles in the first migration:
> - `ledger_owner` — owns the schema, used only by the migration CLI
> - `ledger_app` — the runtime role, with `SELECT, INSERT` on `entries` and
>   `postings` but `UPDATE` and `DELETE` explicitly revoked
>
> Schema:
> ```
> books      (id, name, base_currency, created_at)
> accounts   (id, book_id, name, type, currency, parent_id, closed_at)
> entries    (id, book_id, occurred_at, recorded_at, description,
>             external_id, reversal_of, created_by_user_id, created_by_api_key_id)
> postings   (id bigserial, entry_id, account_id, amount_minor bigint, currency)
> ```
>
> `account.type` is one of asset, liability, equity, revenue, expense.
> Unique constraint on `(book_id, external_id)` where `external_id` is not null.
>
> Enforce the balance invariant with a **deferred constraint trigger** on `postings`
> (`AFTER INSERT`, `DEFERRABLE INITIALLY DEFERRED`, `FOR EACH ROW`) that groups by
> currency and raises unless each group sums to zero. A plain CHECK constraint cannot
> work here — explain why in a comment.
>
> Enforce immutability twice: the `REVOKE` above, plus a `BEFORE UPDATE OR DELETE`
> trigger on both tables that raises unconditionally.
>
> Then write integration tests against a real Postgres (Testcontainers) proving:
> - an unbalanced entry is rejected at COMMIT, not at INSERT
> - a balanced two-leg entry commits successfully
> - a balanced multi-leg (3+) entry commits successfully
> - `UPDATE postings SET amount_minor = 0` fails when connected as `ledger_app`
> - `DELETE FROM entries` fails when connected as `ledger_app`
>
> Do not write any application code beyond what these tests need.

---

## Stage 2 — Config and the core service layer

> Build the config module: a single file, the only place `process.env` is read,
> validated with a Zod schema that throws at boot. Include separate `DATABASE_URL`
> (ledger_app) and `DATABASE_MIGRATION_URL` (ledger_owner). Commit `.env.example`,
> gitignore `.env`, and add an ESLint rule banning `process.env` elsewhere.
>
> Then the ledger service with three operations:
> - `postEntry(bookId, { occurredAt, description, externalId, legs[] })` —
>   validates zero-sum in application code too (fail fast with a clear error before
>   hitting the database), inserts entry + postings in one transaction
> - `getBalance(accountId, asOf?)` — sums postings, naive implementation for now
> - `listPostings(accountId, cursor)` — cursor pagination with running balance
>
> Amounts cross the API boundary as strings, parsed to `bigint` internally. Never let
> a JS `number` touch an amount. Add a `Money` type in `packages/shared` with
> parse/format/add helpers and unit tests including values beyond `Number.MAX_SAFE_INTEGER`.
>
> Introduce an injectable `Clock` interface now — services receive it as a
> dependency. No `new Date()` anywhere in service code.
>
> Idempotency: if `externalId` already exists for the book, return the existing entry
> with 200 rather than creating a duplicate or erroring.

---

## Stage 3 — HTTP layer, auth, authorization

> **Routes:** POST /books, POST /books/:id/accounts, POST /books/:id/entries,
> GET /accounts/:id/balance, GET /accounts/:id/postings, POST /entries/:id/reverse,
> GET /books/:id/trial-balance.
>
> Correct REST semantics: 201 with `Location` on create, 409 on conflict, 422 for
> semantic validation failures vs 400 for malformed input, cursor pagination.
> Error responses use RFC 9457 Problem Details (`application/problem+json`).
>
> **Authentication:** argon2id password hashing. 10-minute access JWT returned in the
> body (frontend holds it in memory). Opaque refresh token, stored hashed with a
> pepper, delivered as `httpOnly; Secure; SameSite=Lax` cookie scoped to `/auth`.
> Rotate on every refresh. Implement **reuse detection**: each session is a token
> family; presenting an already-redeemed token revokes the whole family. Test it.
>
> **Authorization:** per-book roles — `owner`, `accountant`, `viewer` — in a
> `book_members` table. Single policy map:
> ```ts
> const POLICY = {
>   'book:read':      ['owner', 'accountant', 'viewer'],
>   'account:create': ['owner', 'accountant'],
>   'entry:post':     ['owner', 'accountant'],
>   'entry:reverse':  ['owner', 'accountant'],
>   'period:close':   ['owner'],
>   'member:manage':  ['owner'],
> } as const;
> ```
> There is deliberately no delete or update permission — those operations do not
> exist in this domain. Do not add them.
>
> **Meta-test:** enumerate every route registered on the Express app and fail if any
> lacks a declared permission requirement.
>
> **Row-level security:** enable RLS on `entries`, `postings` and `accounts` with a
> policy keyed on `current_setting('app.current_book_id')`. The transaction wrapper
> issues `SET LOCAL` after resolving book access. Test that a query without the
> setting, or with the wrong book, returns zero rows.
>
> **API keys** for machine clients: format `lk_<env>_<random>`, store SHA-256 hash
> plus displayable prefix, scoped to one book with one role, track `last_used_at`.
> Support an `Idempotency-Key` header as transport-level replay protection, distinct
> from and complementary to `external_id`.

---

## Stage 4 — Reversals, trial balance, and the concurrency problem

> Implement `reverseEntry(entryId)`: creates a new entry with `reversal_of` set and
> every leg negated. An entry may be reversed at most once — enforce with a partial
> unique index on `reversal_of`. Reversals of reversals are permitted.
>
> Trial balance report: every account with its balance, grouped by account type,
> with the assertion that total debits equal total credits.
>
> **Then the concurrency work.** Add an overdraft rule: a designated account type
> may not go negative.
>
> 1. Implement it naively — read balance, check, insert.
> 2. Write a test firing N concurrent transfers that would each individually pass the
>    check. Watch it produce a negative balance under READ COMMITTED. **Commit this
>    failing test on its own branch — it is evidence.**
> 3. Fix it twice: once with `SELECT ... FOR UPDATE` on the account row, once with
>    `SERIALIZABLE` isolation plus retry on `40001`.
> 4. Write `docs/adr/0004-concurrency-control.md` comparing them: contention
>    behaviour, deadlock risk, retry complexity, and which you shipped and why.

---

## Stage 5 — Property-based tests

> Using fast-check, generate arbitrary sequences of valid entries against a book and
> assert after every case:
>
> - the sum of every posting in the book is exactly zero
> - each account's balance equals the sum of its own postings
> - posting an entry then reversing it restores every affected balance exactly
> - the trial balance report agrees with per-account sums
> - total value is conserved across concurrent transfers, and the overdraft rule
>   never breaks
>
> When fast-check shrinks a failure to a minimal counterexample, save it as a
> permanent regression test and note the story in the README.
>
> Also add a query-count assertion helper (count statements via a pg event listener)
> and assert the postings list endpoint executes a bounded number of queries, so an
> N+1 regression fails CI.

---

## Stage 6 — Frontend

> React 19 + Vite + TanStack Query + React Hook Form + Zod schemas imported from
> `packages/shared`. Tailwind.
>
> Screens, in this order:
> 1. **Entry composer** — dynamic legs, live "unbalanced by €4.20" indicator,
>    submit disabled until zero. This is the centrepiece; build it first.
> 2. Account tree with current balances
> 3. Account detail: paginated postings with running balance
> 4. Trial balance report
> 5. Reversal flow with a before/after impact preview and confirmation
>
> Errors surface the `X-Request-Id` in the toast so a user-visible failure is
> greppable in the structured logs.

---

## Stage 7 — Performance and documentation

> Seed 500,000 postings. Show `EXPLAIN ANALYZE` for the balance query before and
> after adding indexes, both pasted into `docs/performance.md`.
>
> Implement balance snapshots keyed on **posting id**, not date:
> `balance = checkpoint.balance + SUM(postings WHERE id > checkpoint.through_id)`.
> Explain in a comment why a date-keyed checkpoint is invalidated by backdated
> entries and an id-keyed one cannot be. Add a test asserting the snapshot path and
> the naive sum-from-zero path always agree.
>
> Then:
> - `README.md` with a Decisions & Tradeoffs section
> - 5 ADRs, including one where you chose the boring option
> - `docs/limitations.md` — honest list of what you would fix
> - OpenAPI spec generated from the Zod schemas, served at `/docs`
> - GitHub Actions: typecheck, lint, test, on every push

---

## Optional extensions

Multi-currency with an FX gain/loss account. Bitemporal queries answering "what did
we believe the March balance was, on March 31?" separately from "what do we now know
it to be." Period closing with a `PERIOD_CLOSED` domain error. A group expense
splitter on top, where settlement minimisation becomes its own property-tested
algorithm.

---

## Review checklist between stages

Before moving on, confirm the agent has not:

- [ ] stored a balance as a mutable column
- [ ] used a JS `number` for any monetary amount
- [ ] added an UPDATE or DELETE path to entries or postings
- [ ] validated the zero-sum rule only in application code
- [ ] called `new Date()` inside a service
- [ ] mocked the database in an integration test
- [ ] widened a permission beyond the policy map
- [ ] silently chosen one side of a real tradeoff without telling you
