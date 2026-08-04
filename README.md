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

## Property-based tests

The suites above pin the cases someone thought of. `apps/api/tests/properties/` states the same
invariants as fast-check properties and lets the generator look for the cases nobody thought of —
against the real database, because half of what this project asserts is enforced in migrations
rather than in TypeScript.

An `fc.commands` sequence drives `LedgerService` — post, reverse, read a balance, page through
postings, read the trial balance — while an in-memory model is advanced alongside it. After every
command:

1. the book sums to zero in every currency
2. every balance equals the sum of that account's own postings
3. the trial balance agrees account by account, and its per-currency totals match the model's
4. no guarded account's minimum running balance is below zero — computed twice, once by a SQL
   window function and once by an array scan, which is what pins the `(occurred_at, id)`
   tiebreaker
5. a reversal changes each affected balance by exactly the negation of the original's legs

The model **follows**: it records what the service accepted and never predicts a refusal, so the
overdraft rule is not written a third time after migration `0007` and the service. The price is
that a service refusing everything would satisfy all five, so a sixth invariant asserts the one
class of entry that is *provably* acceptable — one carrying no negative leg on a guarded account
cannot lower any prefix — and a tally across the run asserts acceptances stay the clear majority.
The fixture's opening balance is tuned against that tally by measurement, not by taste: too
generous and nothing is ever refused, too thin and the majority assertion fails.

`LEDGER_PROPERTY_RUNS` sets the case count, defaulting to 25 so `pnpm test` stays usable. A pass
at 200 takes about two minutes.

### What it found

An amount above `2^63 − 1` — the ceiling of the `bigint` column that stores minor units — passes
every validation layer and then answers **HTTP 500**. `amount` is typed only as a string,
`parseMoney` checks decimal shape and non-zero but never magnitude, and no domain error covers the
case, so the request reaches the error middleware's catch-all and is logged as an unanticipated
bug. That middleware special-cases malformed JSON precisely because it would otherwise be "a 500
for what is unambiguously a client mistake"; an out-of-range amount is the same category and gets
none of the same treatment. From the caller's side it is indistinguishable from a server fault.

No example test would have found it, because nobody writes `9223372036854775808` by hand. The
generator did, on its first run. The fix is production code and belongs to a later stage; the
boundary property is bounded at the real ceiling meanwhile, with the reason stated at the constant.

### The corpus

`apps/api/tests/properties/regressions.ts` holds counterexamples this suite has found,
transcribed and replayed on every run through fast-check's `examples` option — which, unlike a
recorded seed, states what it defends against and survives the generators being rewritten.

It is currently empty, and deliberately so. The one defect above cannot be expressed as an entry:
the generator is now bounded below that ceiling, and a case the generator cannot produce cannot be
replayed. Nothing was planted here to demonstrate the mechanism.

### Query counting

`apps/api/tests/services/query-count.test.ts` measures the statements a read path actually sends,
counting at the driver rather than through the ORM — `BEGIN`, `set_config` and `COMMIT` are round
trips too. It asserts that `listPostings` sends the same statements for a page of 1 as for a page
of 50, and that the trial balance is invariant to how many accounts a book has.

An N+1 returns exactly the right answer, just once per row, so it is invisible to every other test
here. The exact counts are pinned beside the invariance assertions, with each statement named, so
that replacing one is a deliberate edit rather than a silent drift.

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
number of concurrent withdrawals; they differ in what the losers are told, and that difference
is not merely cosmetic. Nothing translates an exhausted `40001` into a domain error, so under
`serializable` a contested withdrawal that `row-lock` answers with a 422 `ACCOUNT_OVERDRAWN`
instead exhausts `DrizzleUnitOfWork`'s retries and reaches the client as a 500. That is why
`row-lock` ships as the default rather than `serializable`; the full argument, including the
measurement that found it, is `docs/adr/0004-concurrency-control.md`.

## Two connections, two roles

`ledger_owner` owns the schema and is used only by the migration CLI.
`ledger_app` is the runtime role: `SELECT` and `INSERT` on `entries` and `postings`, with
`UPDATE`, `DELETE` and `TRUNCATE` revoked. The application never holds a connection capable
of rewriting history. Keeping the two apart is what makes the revoke meaningful — a role
that could migrate could also grant itself back what it lost.
