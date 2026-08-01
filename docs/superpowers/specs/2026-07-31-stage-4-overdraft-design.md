# Stage 4 — the overdraft rule and concurrency control

Status: approved 2026-07-31.

Builds on stage 3 (HTTP boundary, authentication, per-book authorization, row-level
security). Reversals and the trial balance already landed on this branch. What remains of
stage 4 is the overdraft rule and the concurrency work it exists to expose.

## Goals

- A designated account type may not hold a negative balance at any point in its history.
- A demonstration that the naive implementation of that rule is wrong under concurrency,
  committed as reproducible evidence rather than described.
- Two correct implementations — row locks and `SERIALIZABLE` with retry — both built,
  both tested, one shipped.
- `docs/adr/0004-concurrency-control.md` comparing them with numbers from this repository.

## Non-goals

- Per-account overdraft limits. A `overdraft_limit_minor` column is a strictly later
  addition that changes no part of the concurrency work; adding it now would only widen
  the surface of the stage that is actually about locking.
- Balance checkpoints, read-path indexes, `EXPLAIN ANALYZE`. Stage 7, which takes the
  window scan below as one of its subjects.
- Property-based tests. Stage 5, which states this rule as an invariant over arbitrary
  entry sequences.
- Backfilling or rejecting existing negative balances. See "Existing data".

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| What designates a guarded account | The account type, hardcoded to `asset` | The check stays a pure function of data already on the row. No migration, no API field, no per-book configuration — so the stage stays about locking rather than about policy expressiveness. A per-account limit column can be added later without touching any of the concurrency work. |
| Which balance the rule constrains | Every historical prefix, not just the current total | `occurred_at` is caller-asserted, so an entry can land in the past. Constraining only the current balance lets a backdated withdrawal drive the account negative at a point in time it claims to describe; constraining only the as-of balance permits a negative balance today. The prefix rule is the only one of the three that is actually true of the data. |
| Prefix ordering | `(entries.occurred_at, postings.id)` | `occurred_at` ties are ordinary — two legs of one entry always tie. `id` is `bigserial`, so it is a total order consistent with recording sequence. Without a tiebreaker "the minimum prefix" is not a well-defined number and the check is non-deterministic. |
| Reversals | Subject to the same check, with an error that names the shortfall | The invariant is a property of the data, not of how the data arrived. An entry that cannot be reversed without breaking it is an entry whose reversal alone is not the correction. Exempting reversals would make the invariant false on the data and stage 5's property unprovable. |
| Database enforcement | A deferred constraint trigger, added *after* the evidence commit | Every other invariant here binds every writer including `psql`. The trigger also narrows the race without closing it, which is the sharpest single point the ADR has to make. Adding it before the evidence commit would make that commit flaky and therefore worthless. |
| Which fix ships | `SELECT ... FOR UPDATE` on the account row | The prefix semantics make the read set the account's entire posting range, which is the shape SSI handles worst. Row locks degrade into waiting; `SERIALIZABLE` degrades into `40001`s the client has to understand. |

## The rule

New `apps/api/src/domain/overdraft.ts`, one exported constant beside `POLICY`:

```ts
/** Account types that may not hold a negative balance at any point in their history. */
export const GUARDED_ACCOUNT_TYPES = ['asset'] as const;
```

One authority, imported by the service and mirrored by the trigger's SQL. That mirroring
is duplication of the same kind `policy.ts` and the `book_role` enum already carry, and it
gets the same treatment: a test asserts the two agree.

**The predicate.** For a guarded account, order its postings by `(occurred_at, id)` and
require every prefix sum to be non-negative — equivalently, that the minimum running
balance is at least zero.

**The query**, one statement per account being checked, in the repository:

```sql
select running::text as shortfall, occurred_at
from (
  select
    sum(p.amount_minor) over (
      order by e.occurred_at, p.id
      rows between unbounded preceding and current row
    ) as running,
    e.occurred_at
  from postings p
  join entries e on e.id = p.entry_id
  where p.account_id = $1
) prefixes
order by running asc, occurred_at asc
limit 1
```

Returning the offending row rather than a bare `min()` costs one column and lets the error
say when the account went short. `::text` then `BigInt()`, as with every other sum here.

**When it runs.** Inside the transaction, after the entry and its postings are inserted,
so the new legs are simply part of the history being examined. No merging of pending state
with committed state, and reversals are covered by the same code path with no special
case. A violation throws and the transaction rolls back. Same shape as the zero-sum
invariant: establish the state, then ask whether it is legal.

**Which accounts are checked.** Guarded accounts the entry touches that carry at least one
**negative leg**. If every leg on an account is non-negative the check is skipped, and the
argument is that all legs of an entry share one `occurred_at` and new postings receive ids
above every existing row — so prefixes before the entry's position are untouched and every
prefix at or after it rises monotonically.

Net-positive is *not* sufficient. An entry with `-100` and `+150` on the same account nets
`+50` and dips between the two legs. The condition is per-leg.

## Concurrency

### Commit sequence

The order is itself a deliverable, so it is specified as commits.

1. **Naive rule.** Service-level: no locking, insert, check, throw. Single-threaded tests
   pass — the rule genuinely works, which is what makes step 2 worth writing.
2. **The evidence.** N concurrent transfers, each individually passing the check,
   producing a negative balance under READ COMMITTED. Committed on
   `evidence/overdraft-race`, branched from this branch and never merged. The branch tip
   stays red permanently and is reproducible by checkout; keeping it off `stage-4` is what
   stops permanent evidence from meaning permanently red CI.
3. **Migration `0007`, `LG004`.** The deferred constraint trigger. The same concurrency
   test now fails *intermittently* rather than reliably.
4. **Fix one: `FOR UPDATE`.** Ships.
5. **Fix two: `SERIALIZABLE` + retry on `40001`.** Built and tested, not shipped.
6. **`docs/adr/0004-concurrency-control.md`.**

### The trigger

Migration `0007`, SQLSTATE `LG004`, following `assert_entry_balanced` exactly:
`SECURITY DEFINER` with a pinned `search_path`, `AFTER INSERT ON postings`,
`DEFERRABLE INITIALLY DEFERRED`, `FOR EACH ROW`, reading the guarded types from the
account row.

`SECURITY DEFINER` for the same reason as `LG001`: `postings` is behind row-level
security, and a `SECURITY INVOKER` function would aggregate only the rows the current role
can see, so an account could pass under RLS while being overdrawn in fact.

The trigger narrows the race and does not close it. A constraint trigger's query runs at
COMMIT and, under READ COMMITTED, takes a fresh snapshot — so it sees transactions
committed since the statement that fired it. Two transactions committing simultaneously
can still each run the check before the other commits, both see a safe balance, and both
commit. That is the ADR's central exhibit: a check at COMMIT is not serialization, and the
distance between "rare" and "impossible" is the entire subject.

### Fix one — row locks

Inside the transaction, before the insert: collect the guarded accounts carrying a
negative leg, sort by id, lock in one statement.

```sql
select id from accounts where id = any($1) order by id for update
```

Locking only the negative-leg accounts is sufficient. Two transactions can jointly break
the invariant on account X only if both add negative postings to X, and both of those take
the lock. A concurrent *positive* posting to X is unlocked and invisible to the checking
transaction, which is conservative and never wrong: adding a positive posting at time T
raises the prefixes at or after T and lowers none.

Sorting prevents deadlock between two entries touching the same two guarded accounts in
opposite leg order. Postgres plans `LockRows` above `Sort`, so a single
`ORDER BY ... FOR UPDATE` acquires in sorted order. That is relied on, commented, and
pinned by a test firing mirrored entries concurrently.

`accounts` is behind RLS, so `FOR UPDATE` sees only rows in the current book — correct,
and workable because `transactionInBook` has already issued `SET LOCAL` before any of this
runs.

### Fix two — `SERIALIZABLE` with retry

A retry wrapper around the whole unit of work, capped attempts, retrying `40001` only.

Two things it must get right. The entry id and `recordedAt` are generated before the first
attempt and reused on every retry, so a retried post is the same entry rather than a new
one. And the idempotency-key row is inserted by middleware in its own transaction, outside
the retried scope, so retries cannot collide with it.

### Selecting between them

`LEDGER_CONCURRENCY_STRATEGY`, a zod enum of `'row-lock' | 'serializable'`, defaulting to
`'row-lock'`. The concurrency tests run parameterized over both, which is what lets the ADR
quote contention and abort figures measured here rather than recalled.

### The ADR

`docs/adr/0004-concurrency-control.md` compares contention behaviour, deadlock risk, retry
complexity and abort rate under the prefix rule's wide read set, and records why
`row-lock` ships: the historical-prefix semantics make the read set the account's whole
posting range, which is precisely what SSI handles worst.

## Error surface

```ts
export class AccountOverdrawnError extends DomainError {
  readonly code = 'ACCOUNT_OVERDRAWN';

  constructor(
    readonly accountId: string,
    /** How far below zero the balance falls. Null when the database raised LG004. */
    readonly shortfall: CurrencyImbalance | null,
    readonly occurredAt: Date | null,
    options?: { cause?: unknown },
  ) { /* ... */ }
}
```

`ACCOUNT_OVERDRAWN` joins the `DomainErrorCode` union, so the compiler demands a status
mapping in `error-middleware.ts` — the same mechanism that already stops a new error
falling through to a 500.

**Status 422.** It belongs with `ENTRY_UNBALANCED`: the request is well-formed and names
real accounts, and the ledger declines to record it. Not 409 — nothing about it is
resolved by re-reading and retrying.

The problem document carries `accountId`, `shortfall` as a decimal string through `Money`,
and `occurredAt`. It applies identically to `POST /entries` and
`POST /entries/:id/reversal`.

`LG004` maps in `pg-errors.ts` to the same `AccountOverdrawnError` with null detail, which
is the precedent `UnbalancedEntryError` already sets for `LG001`: the deferred check knows
which account is short and this process does not. Same class, same code, same status,
whichever layer caught it.

**No new permission.** `entry:post` and `entry:reverse` already cover both routes; an
overdraft is a domain rule, not an authorization one. The route meta-test is unaffected.

## Existing data

No backfill and no data migration. The trigger fires on insert, so a book already holding
a negative asset account keeps it; what changes is that the account cannot accept a further
negative leg until it is repaired.

Deliberate. Retroactively rejecting recorded history is what an append-only ledger must
not do, and the alternative is a migration that fails on real books.

## Testing

**Service level — `tests/services/overdraft.test.ts`.** The behavioural spec of the rule:

- A guarded asset rejected when a withdrawal exceeds its balance; liability, equity,
  revenue and expense accounts free to go negative.
- **The distinguishing test:** a backdated withdrawal that dips a historical prefix while
  leaving the current balance positive is rejected. This is the only test separating the
  prefix rule from a current-balance rule, and if it ever passes by accident the rule has
  silently degraded.
- A backdated deposit repairing a historical dip, after which the previously-rejected
  entry is accepted.
- One entry with `-100` and `+150` on the same guarded account: rejected. Per-leg, not
  per-net.
- Two postings at an identical `occurred_at` where the dip exists in one id order and not
  the other, pinning the tiebreaker.
- A reversal that would overdraw: rejected, `ACCOUNT_OVERDRAWN`, with `shortfall` and
  `occurredAt` present. Reversal of a reversal unaffected.

**Database level — `tests/db/overdraft.trigger.test.ts`.** Insert directly through SQL,
bypassing the service, and watch `LG004` fire at COMMIT — as the existing invariant tests
prove the zero-sum rule binds writers that never touch TypeScript. Plus a test asserting
`GUARDED_ACCOUNT_TYPES` and the trigger's account types agree, so the one duplication in
this design cannot drift.

**Concurrency — `tests/concurrency/overdraft.race.test.ts`.** Real pool connections, N
concurrent transfers each individually passing the check. Parameterized over both
strategies; asserts the final balance is non-negative *and* that total value is conserved.
Separately: mirrored-leg-order entries fired concurrently, asserting no deadlock — the test
holding up the `ORDER BY ... FOR UPDATE` claim. Under `serializable`, an assertion that
retries actually occurred, because a retry path that never runs is untested code.

These need their own vitest project: single fork, no per-test transaction isolation, since
genuinely concurrent connections are the point.

The evidence branch carries the naive version of that file asserting the negative balance
*appears*. It is the same test inverted, and the diff between the two branches is the
story.

## Files

New:

```
apps/api/src/domain/overdraft.ts
apps/api/drizzle/0007_overdraft.sql          (+ snapshot, journal)
apps/api/tests/services/overdraft.test.ts
apps/api/tests/db/overdraft.trigger.test.ts
apps/api/tests/concurrency/overdraft.race.test.ts
docs/adr/0004-concurrency-control.md
```

Modified:

```
apps/api/src/domain/errors.ts                AccountOverdrawnError, ACCOUNT_OVERDRAWN
apps/api/src/http/error-middleware.ts        422 mapping, problem extensions
apps/api/src/db/pg-errors.ts                 LG004
apps/api/src/config.ts                       LEDGER_CONCURRENCY_STRATEGY
apps/api/src/repositories/ledger.repository.ts  lockAccounts, minPrefixBalance
apps/api/src/services/ledger.service.ts      postEntry, reverseEntry
apps/api/src/db/client.ts                    serializable strategy, retry wrapper
apps/api/vitest.config.ts                    concurrency project
apps/api/tests/helpers/ledger.ts             guarded-account fixtures
```
