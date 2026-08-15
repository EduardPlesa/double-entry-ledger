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
commit **`eb67ffa`** — pushed, never merged, permanently red by design. It carries the same
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

## Option A — `SELECT ... FOR NO KEY UPDATE` on the accounts at risk

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
concurrent *positive* posting is not blocked, and does not need to be — adding a positive
posting at time T raises the prefixes at or after T and lowers none, so a depositor cannot
turn a decision taken under this lock into the wrong one.

**The lock mode is `FOR NO KEY UPDATE`, and that is a correction rather than a detail.** The
first implementation used `FOR UPDATE`, and it deadlocked on a case neither the reasoning
above nor the deadlock suite reached. Inserting a posting makes Postgres check
`postings_account_same_book_currency_fk` against the parent row, which it does as
`SELECT 1 FROM accounts ... FOR KEY SHARE` — so an entry takes a lock on the accounts of its
*positive* legs too, one that `lockAccountsAtRisk` never requests, never sees and therefore
never orders. `FOR UPDATE` conflicts with `FOR KEY SHARE`. A transfer of `[cash −100, bank
+100]` held `cash` explicitly and then waited on `bank` implicitly, while the mirrored
`[bank −100, cash +100]` did the reverse; Postgres killed one with `40P01`, `withRetry`
deliberately does not retry that, nothing translated it, and the loser of a perfectly
legitimate transfer got an HTTP 500.

`FOR NO KEY UPDATE` conflicts with itself, so two withdrawals from one account still
serialise — the only thing the lock exists to do, and what the race test measures. It does
not conflict with `FOR KEY SHARE`, so the foreign key checks and the concurrent deposits pass
freely. The claim in the paragraph above is therefore true for a mechanical reason and not
merely a conservative approximation. `tests/concurrency/deadlock.test.ts` now carries the
crossed-transfer case as the positive control: it reproduced a genuine `40P01` on the first
round against `FOR UPDATE`, and passes against `FOR NO KEY UPDATE`.

**What it buys.**

- Contention is **per account**. Two entries touching disjoint accounts never interact.
- Writers **block** rather than fail. There is no new caller-visible error and no failure
  mode a client has to be taught about.
- No retry loop, so nothing in the unit of work has to be made repeatable.

**What it costs.**

- A writer to a hot account waits for the whole check, not just for the insert. The check is
  `lowestPrefixBalance`, a window function over that account's entire posting range, and it
  runs while the lock is held. **And the wait grows with the whole `postings` table, not with
  the account's history** — `postings` carries no index on `account_id`, so this is a
  sequential scan of every posting in the database that then discards the rows belonging to
  other accounts. The deferred `LG004` trigger runs the same scan again at COMMIT, once per
  inserted guarded posting, and COMMIT is still inside the lock window. So a single two-legged
  withdrawal from a guarded account pays for at least two full table scans with the row lock
  held, and what makes them expensive is every other account's traffic.
- `accounts` is behind row-level security, so the lock sees only rows in the current
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
  `maxAttempts` at its default of 5.

  That figure deserves a caveat rather than a decimal point. `maxAttempts` counts total
  attempts, so the ceiling is 96 × 4 = 384 retries; 390 sits slightly *above* that ceiling,
  which means the count and the model disagree and at least one of them is imprecise. The
  shape of the finding — most contested calls aborting nearly to the cap — is robust and is
  what the decision rests on. The exact number is not, and should not be quoted as though it
  were.

- **Retries do not merely run close to the cap; they hit it, every time, for every loser.**
  An earlier revision of this document said no call was reported as exhausting `maxAttempts`.
  That was wrong, and the hardened assertions in `tests/concurrency/overdraft.race.test.ts`
  are what found it. Classifying every rejection by SQLSTATE across five rounds of the
  standard scenario — €500.00, sixteen concurrent €100.00 withdrawals — gives an identical
  result on every round under each strategy:

  | strategy       | accepted | rejected | `ACCOUNT_OVERDRAWN` | exhausted `40001` |
  | -------------- | -------- | -------- | ------------------- | ----------------- |
  | `row-lock`     | 5        | 11       | 11                  | 0                 |
  | `serializable` | 5        | 11       | 0                   | 11                |

  **The accepted count is the same under both, and that is the point worth keeping**: both
  strategies enforce the rule exactly, admitting the five withdrawals the money pays for and
  no more. What differs is entirely in what the eleven losers are told. Under row locks every
  one of them receives the domain's own answer — a 422 saying the account cannot afford it,
  which is true and actionable. Under SSI **not one of them ever gets that far**: the read set
  is the account's whole posting range, so each loser is aborted, retried to the cap, and
  ultimately handed a raw serialization failure describing a database condition rather than a
  business one. The claim in the decision below that "waiting degrades better than a `40001`
  the client has to understand" is not a prediction; it is this table.
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
reversed to `DESC`.

Both orderings are kept anyway, as **contract rather than as accident**. They state what
these call paths promise, rather than what they currently get for free from an index that
could be dropped or reshaped later.

**But the deadlock that actually existed was not this one, and no amount of lock ordering
would have prevented it.** Both entries in the end-to-end test above drain *both* accounts, so
both accounts land in both at-risk sets and the sorted order applies to everything either
transaction touches. A crossed *transfer* — `[cash −100, bank +100]` against
`[bank −100, cash +100]` — does not have that shape: each side explicitly locks one account
and merely writes to the other. The write is not lock-free. Inserting a posting makes Postgres
check `postings_account_same_book_currency_fk` as `SELECT 1 FROM accounts ... FOR KEY SHARE`
on the parent row, and under `FOR UPDATE` — which conflicts with `FOR KEY SHARE` — each side
held one account and waited on the other through a lock the service never requested, never saw
and therefore never sorted. Postgres killed one with `40P01`; nothing retried or translated it;
a legitimate transfer became an HTTP 500. Sorting cannot fix a lock you do not know you are
taking. **Weakening the mode to `FOR NO KEY UPDATE` can, and does** — see Option A above.

**The crossed case is now a committed test.** An earlier revision noted a scratch
positive-control that crossed the locks by hand, provoked a genuine `40P01`, and was thrown
away. `tests/concurrency/deadlock.test.ts` now carries the crossed-transfer scenario instead,
which is better than that control was: it is a *negative* test that reproduced a real `40P01`
on its first round against `FOR UPDATE` and passes against `FOR NO KEY UPDATE`, so it both
proves the harness detects deadlocks and fails if this regresses. It also reads the SQLSTATE
through `hasSqlState` rather than off `error.code`, because drizzle wraps the driver's error
and the top-level `code` is `undefined` for every deadlock there is — an assertion built on it
reports `[undefined]` and passes `not.toContain('40P01')` while the deadlock is happening.

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

- **The overdraft check is a sequential scan under a row lock.** `postings` deliberately
  carries no index on `account_id` yet — see the note in `apps/api/src/db/schema.ts` — so the
  check reads the *entire* table and keeps the rows for one account. The duration of the lock
  therefore grows with the size of the whole ledger, not with the account's own history, and
  it is paid twice per write: once by `lowestPrefixBalance` inside the transaction, once more
  by the `LG004` trigger at COMMIT, per inserted guarded posting, still inside the lock window.
  That reclassifies `postings(account_id)` from a read-path index to a **write-path index on
  the system's hottest critical section**, which is a materially stronger reason to add it than
  the one recorded when it was deferred. It is still deferred, deliberately: stage 7 takes it
  as one of its subjects, with `EXPLAIN ANALYZE` either side, and any balance-checkpoint work
  there changes the read set this decision was made about. Recorded here as a known cost being
  carried on purpose.
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
- **The crossed-transfer test is the deadlock suite's control, and it is committed.** An
  earlier revision of this document proposed a hand-crossed positive control as a candidate
  canary and recorded that it had been thrown away. What is committed instead is better: a
  scenario that reproduced a genuine `40P01` against `FOR UPDATE` on its first round and passes
  against `FOR NO KEY UPDATE`. That is simultaneously the evidence the harness detects
  deadlocks — which the two negative tests beside it cannot establish about themselves — and a
  regression test for the bug that was actually there.
- **`ACCOUNT_OVERDRAWN` is a 422 regardless of which layer catches it, and regardless of which
  write path reached it.** The service raises it from `assertNoOverdraft` with the shortfall
  and the offending instant; `LG004` is translated to the same class with null detail, because
  the deferred check knows which account is short and this process does not. `postEntry` and
  `reverseEntry` now share one translator, so a reversal that would overdraw an account answers
  the same 422 as a post that would — through the reversal path the identical database
  condition was previously an untranslated 500.
- **`ACCOUNT_OVERDRAWN` is not cached by the idempotency middleware.** It is the first outcome
  in this system that depends on the state of the ledger rather than on the request: the same
  body succeeds or fails depending on a balance that anything else can change. Replaying it
  would pin an answer that has since stopped being true, against exactly the client doing the
  right thing — take the 422, deposit the shortfall the response named, retry under the same
  key. The key still guarantees the withdrawal happens at most once; it is the response, not
  the effect, that is allowed to differ between attempts. See `isReplayable` in
  `apps/api/src/middleware/idempotency.ts`.
- **Migration `0007` validates the existing rows before it creates the trigger.** A constraint
  trigger binds future inserts only, and the service's negative-leg-only optimisation is sound
  only where the invariant already holds: on an account that is already negative, a pure
  deposit skips the service check entirely and then trips `LG004` at COMMIT, producing a
  rejection with no account id and no shortfall for a request that was trying to fix the
  problem. The migration therefore scans for a negative prefix and refuses to apply rather than
  leaving the assumption to luck. The trigger's own `WHEN` clause was deliberately left broad:
  narrowing it to negative postings would make it a mirror of the service's optimisation
  instead of an independent check of it.

## Amendment, 2026-08-08: the write path locks every touched account, not only the at-risk ones

Everything above describes the lock this decision shipped with: `lockAccountsAtRisk` collects
only the guarded accounts an entry takes money out of, and that set is what `postEntry` locks
before inserting. That is no longer what the code does. `LedgerService.lockTouchedAccounts`
replaces it, and it locks every account named in an entry's legs - guarded or not, losing
money or gaining it.

**Why it widened.** Stage 7 added `LedgerService.checkpointAccount`, which reads
`max(postings.id)` and `sum(amount_minor)` for an account in one statement and stores the
result as a watermark other reads can resume from. That statement is only a safe watermark if
no posting for the account can be mid-insert while it runs, and nothing about the statement
itself can establish that: `postings.id` is a `bigserial`, `nextval()` fires at INSERT and is
not transactional, so id order and commit order can disagree, and a single consistent read of
`postings` cannot tell "no writer is mid-insert" apart from "one is, and this read simply
cannot see its uncommitted row yet." Two designs tried to infer safety from the read alone -
comparing each posting's `xmin` against a snapshot boundary, and draining every transaction a
snapshot's `xip_list` named before recomputing - and both were disproved with a reproducible
counter-example against live Postgres 16. `docs/adr/0005-balance-checkpoints.md` carries both
counter-examples in full; the short version is that inference from within a single read was
never going to close this gap, no matter which snapshot function it read from.

The fix is the same one this document already made for the overdraft rule: stop inferring,
exclude instead. `checkpointAccount` takes the account's `FOR NO KEY UPDATE` lock before its
read, which is only a guarantee if the write path is guaranteed to hold that same lock for
every posting it inserts on that account - not only the postings that could overdraw it. A
positive-leg posting was exactly the case the old, narrower lock let through unlocked, and it
is exactly the case that would have made a checkpoint's watermark wrong. Widening
`lockTouchedAccounts` to cover every account a leg touches is what closes that gap; there is
no narrower set that both suffices for `checkpointAccount` and still excludes some writes, so
it is not a middle ground this amendment declined to take.

**What it costs.** A pure deposit - an entry with no negative leg on any guarded account - now
takes the account lock and can block, or be blocked by, another write to the same account.
Option A's analysis above specifically noted the opposite as a property of the original
design: "a concurrent *positive* posting is not blocked, and does not need to be." That
sentence is no longer true. It was true of the overdraft rule alone, and the overdraft rule
alone is no longer the only reason this lock exists.

**What did not change.** The lock mode is still `FOR NO KEY UPDATE`, for both of the reasons
already on record - it does not conflict with the `FOR KEY SHARE` the postings foreign-key
check takes on an account row, and the crossed-transfer deadlock `FOR UPDATE` produced does
not recur under it. The accounts touched by one call are still locked in one ascending-id
order, by the same sort this document already documents as contract rather than as an
accident of index layout; `tests/concurrency/deadlock.test.ts` exercises the same mechanism
over the now-wider set it locks. `LEDGER_CONCURRENCY_STRATEGY=serializable` still skips the
account lock entirely on the write side, for the same reason as before - SSI is already
tracking the conflict, and an explicit lock would only serialise writers SSI would otherwise
let through. What changes under `serializable` is on the read side, not here:
`checkpointAccount` cannot get the same guarantee from SSI that it gets from the lock, and
refuses to run under that strategy rather than write a watermark it cannot vouch for -
`docs/adr/0005-balance-checkpoints.md` is the one place that refusal is argued in full.

**The Deadlock risk section above needs one correction in light of this widening, not just a
note that it still holds.** That section's account of the crossed-transfer case -
`[cash −100, bank +100]` against `[bank −100, cash +100]` - says "each side explicitly locks
one account and merely writes to the other," with the other account reached only through the
implicit `FOR KEY SHARE` the postings foreign-key check takes. That description was accurate
under `lockAccountsAtRisk`, which locked only the negative-leg account on each side. It is no
longer accurate: `lockTouchedAccounts` locks every account a leg names, so both `cash` and
`bank` are now explicitly locked, sorted, on *both* sides of the crossed transfer - the same
shape the section already describes for two entries that each drain both accounts. The
`FOR NO KEY UPDATE` mode is still what makes the *un*-widened original code safe against the
`FOR KEY SHARE` the foreign-key check takes, and that argument is unchanged and still load-
bearing generally. But the crossed-transfer case specifically no longer needs it to avoid a
deadlock: the widened lock set means both transactions now request `cash` and `bank` through
the same explicit, sorted call, so the second to arrive blocks on the first account in the
order rather than each holding one and waiting on the other. `tests/concurrency/deadlock.test.ts`
passes against the widened lock, but for a reason one layer deeper than before.
