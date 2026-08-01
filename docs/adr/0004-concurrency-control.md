# 4. Concurrency control for the overdraft rule

Date: 2026-08-02
Status: accepted

The number comes from the stage plan rather than from three earlier records: this is the
first ADR committed to this repository, and it establishes the headings the next one should
follow.

## Context

A guarded account — an `asset` account, per `GUARDED_ACCOUNT_TYPES` in
`apps/api/src/domain/overdraft.ts` — may not hold a negative balance **at any point in its
history**, not merely at the end of it.

The "at any point" is the part that shapes everything below. `occurred_at` is asserted by
the caller, so an entry recorded today can land in the past. A rule about the current
balance alone would accept a backdated withdrawal that overdrew the account on the very
date it claims to describe, and a rule about one as-of instant would permit a negative
balance today. The predicate is therefore over every prefix: order the account's postings
by `(entries.occurred_at, postings.id)` and require every running sum to be non-negative.
`postings.id` is a `bigserial`, and the tiebreaker is load-bearing rather than decorative —
two legs of one entry always share an `occurred_at`, so without it "the minimum prefix" is
not a well-defined number.

The rule is implemented in `LedgerService.assertNoOverdraft`, which runs *after* the insert
so the new legs are simply part of the history being examined, and it reads through
`DrizzleLedgerRepository.lowestPrefixBalance` — one window function over the account's
whole posting range, returning the offending prefix so the error can say when the account
went short.

**Read, check, insert is not enough.** Under READ COMMITTED each transaction reads a
snapshot taken before any of its competitors committed. Sixteen individually affordable
withdrawals can each pass the check, each insert, and each commit, leaving the account
overdrawn by an amount no single request ever asked for. The check and the write it
authorises are two statements with a window between them, and no amount of care in the
service closes that window.

This is committed as evidence rather than described. Branch **`evidence/overdraft-race`**,
commit **`3bb3d7c`** — pushed, never merged, permanently red by design. It carries the same
`tests/concurrency/overdraft.race.test.ts` against the naive implementation, asserting that
the negative balance does *not* appear; the diff between that branch and this one is the
story.

**Measured on that branch.** Sixteen concurrent withdrawals of €100.00 against an account
holding €500.00, five rounds. It failed on **round 1**, with a balance of **−20 000 minor
units** — seven withdrawals committed where five were affordable. In the same run the
`conserves total value` assertion **passed**: the zero-sum invariant is enforced by a
deferred constraint trigger (`LG001`) and never broke. The race produces an account that is
overdrawn, not a book that fails to add up, and that distinction is why the rest of this
document is about one specific check rather than about transactions in general.

## The trigger is not a fix

Migration `0007` adds `LG004`: a `SECURITY DEFINER`, `AFTER INSERT ON postings`,
`DEFERRABLE INITIALLY DEFERRED`, `FOR EACH ROW` constraint trigger running the same prefix
query. It exists for the same reason every other invariant here is in the database — it
binds `psql`, and it binds a future version of the service with a bug in it.

It does not make the rule safe under concurrency, and the mechanism says why. A constraint
trigger's query runs at COMMIT, and under READ COMMITTED it takes a **fresh snapshot** —
so it sees transactions committed since the statement that fired it. That is strictly more
than the service's in-transaction check sees. But two transactions committing at the same
moment can still each run the check before the other commits, both observe a safe balance,
and both commit. A check at COMMIT is not serialization; it is an earlier check.

**What the measurement shows, and what it does not.** Re-running the same race on this
branch after `LG004` landed and before the row locks: it failed on **round 1** again, at
**−10 000 minor units** — six withdrawals committed. The round at which the race first
reproduces is **unchanged**. The depth differed by one withdrawal between two single runs,
which is not evidence of anything at this sample size.

So: the argument that the trigger narrows the window is an argument about the mechanism,
and it is a sound one. The claim that the narrowing is *measurable at this concurrency
level* is **not supported** by the numbers taken here. At sixteen concurrent writers on one
account the race reproduces on the first round with or without the trigger. A run that
distinguished them would need either far lower concurrency or far more rounds, and neither
was done.

## Option A — `SELECT ... FOR UPDATE` on the accounts at risk

Before the insert, the service collects the guarded accounts the entry takes money out of,
sorts them, and locks their rows in one statement
(`LedgerService.lockAccountsAtRisk` → `DrizzleLedgerRepository.lockAccounts`). The lock is
on `accounts`, not on `postings`, because the rows being inserted do not exist yet — the
account row is the pre-existing thing every writer to that account must pass through, which
turns "check then insert" into a decision only one transaction can be making at a time.

The lock is taken *before* the insert deliberately. A lock taken afterwards would still
leave the read that decides the entry's fate outside any mutual exclusion, which is the
entire bug.

Only negative-leg accounts are locked, and that is sufficient: two transactions can jointly
overdraw an account only if both take money out of it, and both of those arrive here. A
concurrent *positive* posting is unlocked and unseen, which is conservative rather than
wrong — adding a positive posting at time T raises the prefixes at or after T and lowers
none.

**What it buys.**

- Contention is **per account**. Two entries touching disjoint accounts never interact.
- Writers **block** rather than fail. There is no new caller-visible error and no failure
  mode a client has to be taught about.
- No retry loop, so nothing in the unit of work has to be made repeatable.

**What it costs.**

- A writer to a hot account waits for the whole check, not just for the insert. The check is
  `lowestPrefixBalance`, a window scan over that account's entire posting range, and it runs
  while the lock is held. The wait therefore grows with the account's history.
- `accounts` is behind row-level security, so `FOR UPDATE` sees only rows in the current
  book. That is correct, and it works only because `transactionInBook` has already issued
  its `SET LOCAL` before any of this runs.
- It requires a deterministic lock order — see below.

## Option B — `SERIALIZABLE` with retry on `40001`

No explicit locks at all; `lockAccountsAtRisk` returns early under this strategy, because
taking a lock the database is already tracking would serialise writers SSI would have let
through and pay for both mechanisms to get the worse half of each. Correctness becomes
Postgres's problem, and `DrizzleUnitOfWork.withRetry` retries the transaction when Postgres
refuses to serialize it.

**What it costs.**

- **The read set is enormous, by construction.** The prefix rule reads the account's entire
  posting range, so SSI predicate-locks that range, and *any* concurrent insert to that
  account conflicts with it. This is the shape SSI handles worst, and it is not incidental
  to this rule — it is what "every historical prefix" means.
- **Aborts are the normal case under contention.** Instrumenting `onRetry` across the
  concurrency suite — 6 rounds × 16 concurrent writers = 96 contested `postEntry` calls —
  showed on the order of 390 retries, i.e. **roughly four aborts per contested call**, with
  `maxAttempts` at its default of 5 and no call reported as exhausting it.

  That figure deserves a caveat rather than a decimal point. `maxAttempts` counts total
  attempts, so the ceiling is 96 × 4 = 384 retries; 390 sits slightly *above* that ceiling,
  which means the count and the model disagree and at least one of them is imprecise. The
  shape of the finding — most contested calls aborting nearly to the cap — is robust and is
  what the decision rests on. The exact number is not, and should not be quoted as though it
  were.
- **The retry wrapper has to wrap the whole unit of work**, `set_config` included, because a
  retry is a fresh transaction with no book context. Anything that must not repeat has to be
  hoisted out of it: `postEntry` computes the entry id and `recordedAt` before the first
  attempt, so a retried post is the same entry rather than a new one. The idempotency-key
  row is written by middleware in its own transaction, outside the retried scope.
- **The retry loop has no backoff and no jitter.** It re-runs immediately on every `40001`.
  Under the measured workload that means sixteen writers thundering at one another on every
  abort — which is a property of what was measured, not an accident of it, and would want
  revisiting before this strategy carried real traffic.

## Deadlock risk

**Option A has it in principle.** Two entries touching the same two guarded accounts in
opposite leg order would, without a consistent order, have one transaction holding cash and
wanting bank while the other holds bank and wants cash. Postgres resolves that by killing
one with `40P01`. Two things stand against it: `guardedAccountsAtRisk` sorts the ids in
JavaScript before `postEntry` ever calls `lockAccounts`, and `lockAccounts` emits its own
`ORDER BY id`.

**Neither could be shown to be load-bearing on the schema as it stands, and that is worth
recording honestly.** With `ORDER BY id` removed from `lockAccounts`, and with the
JavaScript sort removed as well, no `40P01` occurred. `accounts` carries two btree
structures leading with `id` — the primary key and `accounts_id_book_id_currency_key` — so
Postgres visits an indexed `IN (...)` list's matches in ascending id order regardless of
what the clause says; `EXPLAIN` shows no `Sort` node in any variant, present, absent or
reversed to `DESC`. A separate positive-control test that crossed the locks by hand *did*
provoke a real `40P01`, so the harness genuinely detects deadlocks and the negative result
is not an artefact of the test being blind. That control was scratch work and is not
committed.

Both orderings are kept anyway, as **contract rather than as accident**. They state what
these call paths promise, rather than what they currently get for free from an index that
could be dropped or reshaped later.

**Option B has no deadlocks, but has aborts instead** — a `40001` is the serialization
failure taking the place of the mutual wait.

**`40P01` is deliberately not retried under either strategy.** `withRetry` matches `40001`
only. A deadlock means two transactions took locks in incompatible orders, which is a bug in
the lock ordering rather than bad luck; retrying it would hide the bug behind a slow
success.

## Decision

**`row-lock` ships.** It is the default of `LEDGER_CONCURRENCY_STRATEGY`, and the argument
is about mechanism, not about a stopwatch.

The prefix semantics force the read set to be the account's whole posting range. That is
precisely the shape SSI handles worst: a wide predicate lock that every concurrent writer to
the same account conflicts with, producing aborts as the ordinary outcome of ordinary
contention rather than as an exceptional one. The measured abort behaviour is consistent
with that prediction. Under row locks the same contention becomes waiting, and **waiting
degrades better than a `40001` the client has to understand**: blocking is invisible to the
caller and needs no new error semantics at the API boundary, whereas a serialization failure
either surfaces as a retryable error every client must handle or is hidden behind a retry
loop whose cost is unbounded in exactly the workload that provokes it.

**The wall-clock numbers establish nothing and are not part of this argument.** The run
recorded 866.069 ms for the `row-lock` block and 823.732 ms for the `serializable` block.
That is a single, unaveraged run, and the report it came from put machine noise at tens of
percent — far larger than the 42 ms between them. **No wall-clock winner is established at
this scale; the two strategies are indistinguishable in the measurement taken.** Neither
figure is reproducible from the committed code: both came from temporary instrumentation
that was removed.

`LEDGER_CONCURRENCY_STRATEGY=serializable` keeps the alternative runnable, and the
concurrency suite is parameterized over both strategies so it stays tested rather than
becoming a comment about a path that once worked. If the read set is ever narrowed — by a
balance checkpoint, say, that makes the check read a bounded suffix instead of the whole
history — the argument above weakens and this decision is worth re-taking with numbers that
actually separate the two.

## Consequences

- **The overdraft check is a window scan under a row lock.** It reads every posting on the
  account, and `postings` deliberately carries no index on `account_id` yet — see the note
  in `apps/api/src/db/schema.ts`. So the duration of the lock grows linearly with the
  account's history. Stage 7 takes this as one of its subjects, with `EXPLAIN ANALYZE` and
  an index on `postings(account_id)`, and any balance-checkpoint work there changes the read
  set this decision was made about.
- **Stage 5's property tests are what would catch a regression in either strategy.** They
  assert the invariant over arbitrary entry sequences rather than over the specific
  sixteen-writer scenario measured here, which is the coverage the concurrency suite cannot
  give.
- **`tests/concurrency/deadlock.test.ts` has a blind spot, and says so in its own comments.**
  Its direct test cannot currently fail for the regression it was built to catch, because
  the index layout supplies the ordering the clause is supposed to guarantee. What it does
  verify is that calling `lockAccounts` with unsorted input is safe in practice today, and
  it would catch a regression in this method's predicate or in a reshaped index. It is not
  proof that `ORDER BY id` is load-bearing.
- **The uncommitted crossed-lock positive control is a candidate canary.** Committing it —
  as a test that asserts a deadlock *does* occur when locks are deliberately crossed — would
  give the deadlock suite a control that fails if the harness ever stops detecting `40P01`.
  It was not committed here.
- **`ACCOUNT_OVERDRAWN` is a 422 regardless of which layer catches it.** The service raises
  it from `assertNoOverdraft` with the shortfall and the offending instant; `LG004` maps to
  the same class in `pg-errors.ts` with null detail, because the deferred check knows which
  account is short and this process does not. Same class, same code, same status.
