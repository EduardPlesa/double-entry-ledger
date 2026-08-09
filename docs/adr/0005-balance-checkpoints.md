# 5. Balance checkpoints

Date: 2026-08-08
Status: accepted

## Context

`getBalance` computed an account's balance by summing every posting the account has ever
received, from zero, on every call. `docs/performance.md` measures what that costs at
500,000 postings: the `balance-from-zero` plan reads 13,678 buffers and takes 20.826 ms
against a 2,500-posting account, most of it a `Parallel Seq Scan on postings` that reads the
whole table and discards everything belonging to other accounts. An account's history only
grows, so the cost of every future read of that account grows with it. `getBalance` needed a
way to resume from a known-good number instead of re-deriving one every time.

The obvious shape is a cached balance and a watermark saying how far it goes: `balance
through posting X`, plus a sum of whatever has posted since. That is `balance_checkpoints`.
The question this ADR is actually about is what "since" can safely mean.

## Why the key is a posting id and not a date

`entries.occurred_at` is asserted by the caller and can land anywhere in the past;
`docs/adr/0004-concurrency-control.md` already builds the overdraft rule around exactly this
fact. A checkpoint keyed on `occurred_at <= D` inherits the same problem in a worse form. An
entry recorded tomorrow, backdated to describe last March, has an `occurred_at` before `D`,
so it lands inside a set a checkpoint already summed - and the stored balance is now wrong,
silently, with nothing in the row to say so. Invalidating that checkpoint correctly would
mean comparing every entry's `recorded_at` against every checkpoint's date on every read,
which is bitemporal bookkeeping and a different system than the one being built here.

`postings.id` does not have this problem, and the reason is structural rather than
statistical. `id` is a `bigserial`, assigned once at insert and never reused. An entry
backdated in `occurred_at` still draws an id above everything already stored, because the id
says nothing about when the entry claims to have happened - only when the row was created.
So a checkpoint asserting `sum where id <= through_id` never has a later, backdated entry
land inside the set it already summed: the backdated posting's id is necessarily above
`through_id`, so it falls in the delta the checkpoint has not yet accounted for, not inside
the frozen prefix. This argument is about backdating specifically, and it survives everything
below - a checkpoint keyed on `occurred_at` would have been wrong for a reason a posting-id
key cannot be wrong for.

## What that argument does not establish

Backdating-safety is not the same claim as "the summed set is frozen," and treating them as
one claim is the mistake this design almost shipped with. `nextval()`, which assigns a
posting's id, fires at INSERT time - not at COMMIT - and it is not transactional. A
transaction can draw a low posting id, still be open, and lose a race to commit against a
transaction that started later and drew a higher id. So id order and commit order can
disagree, and a checkpoint computed from a single consistent read of `postings` can watermark
above a posting that has already drawn its id but has not yet committed. Once that posting
does commit, its id sits below `through_id` forever: it satisfies `id <= through_id` and is
therefore part of the frozen prefix the checkpoint claims to have already summed, while every
future delta query looks only at `id > through_id` and never sees it. The balance the
checkpoint plus its delta produces is then permanently short by that posting's amount, with
no error, no failed constraint, and no signal anywhere that the number is wrong. This is not
a rare interleaving to be tolerated; it is what a single unlocked `computeCheckpoint` read
does under ordinary write concurrency.

## The two rejected approaches

Two designs tried to make `computeCheckpoint`'s single read safe against this on its own,
without taking a lock. Both were disproved with a reproducible counter-example against live
Postgres 16, not reasoned away.

**Filter rows by `xmin` against `pg_snapshot_xmin(pg_current_snapshot())`.** The idea: take a
snapshot, keep only postings whose inserting transaction's `xmin` is below the snapshot's
`xmin`, and treat everything else as not-yet-safe. This fails because xid order and
posting-id order are independent counters advancing on different events - a transaction gets
its xid on its first write, and a posting gets its id when the specific INSERT statement
executes - so an older-xid transaction can perform its posting insert *later* than an
in-flight, newer-xid transaction's insert. A committed row with an id above the in-flight
transaction's posting can carry an xid that passes the `xmin` filter, while the in-flight
posting itself does not, and the two are not ordered consistently by either column against
the other. Separately, and independently fatal on its own: there is no cast from `xid` to
`xid8`, and `xid` has no ordering operators in Postgres. The comparison this approach needs
cannot be typed, let alone executed - it was never safe even to attempt as written.

**Drain the in-flight list from `pg_snapshot_xip(pg_current_snapshot())`, then recompute.**
The idea: read the snapshot's list of in-progress transaction ids, wait for each one to
finish, and only then compute the checkpoint, on the theory that nothing can still be
mid-insert once every xid the snapshot named has ended. This fails because `xip_list` is not
the complete set of concurrently-running transactions - it omits any running transaction
whose xid is at or above the snapshot's `xmax`, and `xmax` is derived from the latest
*completed* xid at snapshot time, not from every xid handed out so far. A transaction that
started after the newest completed transaction, drew a low posting id, and has not yet
committed can have an xid above `xmax` and therefore never appears in `xip_list` at all. The
drain then runs zero iterations, reports nothing to wait for, and the checkpoint is computed
exactly as unsafely as if no drain had been attempted.

## The decision

Stop inferring, exclude instead. `LedgerService.lockTouchedAccounts` already takes a `FOR NO
KEY UPDATE` lock on every account a write's legs touch, before the write's insert - that is
`docs/adr/0004-concurrency-control.md`'s mechanism for the overdraft rule.
`LedgerService.checkpointAccount` takes the same lock, on the one account it is
checkpointing, before its own read. With the lock held, no writer can be between drawing a
posting id for that account and committing it - the lock is the pre-existing thing every
writer to that account must pass through, exactly as `0004` argues for the write side. This
makes `computeCheckpoint`'s single-statement `max(postings.id)` plus `sum(amount_minor)` a
safe watermark by construction: nothing about xids, snapshots, or commit order is inferred,
because nothing needs to be. The lock removes the condition the two approaches above were
each trying, and failing, to detect from the outside.

`checkpointAccount` refuses outright under `LEDGER_CONCURRENCY_STRATEGY=serializable`, before
any read. Under that strategy `lockTouchedAccounts` skips the account lock entirely on the
write side - `0004`'s Option B - because SSI is already tracking the conflict there and an
explicit lock would only serialise writers SSI would otherwise let through. That reasoning
does not carry over to a checkpoint. SSI aborts a transaction when it detects a cycle of
rw-antidependencies; a checkpoint computed from a wrong watermark is not a cycle from SSI's
point of view, because nothing on the write side is holding a lock for it to conflict with -
it is a single, unclosed rw-antidependency, and SSI lets a transaction with one of those
commit cleanly. Locking the account inside `checkpointAccount` itself would not fix this,
because there is nothing on the write path under `serializable` for that lock to exclude.
There is no cheaper fix available under `serializable` within this design, so rather than
silently compute a checkpoint it cannot vouch for, `checkpointAccount` throws
`CheckpointRequiresRowLockError` before performing any read.

## Consequences

- **What this accelerates.** `getBalance`'s default path (`balanceThrough`, no `asOf`) and
  `listPostings`'s opening balance now resume from a checkpoint's watermark when one exists
  and helps, turning a sum over the account's whole history into a sum over whatever posted
  since the checkpoint. `docs/performance.md`'s delta-sum measurement is the number this
  design exists to produce: 4,247 buffers and 15.113 ms without `postings_account_id_id_idx`
  falls to 3 buffers and 0.045 ms with it, once a checkpoint exists to resume from - about
  336× faster on wall clock.
- **What this does not accelerate.** `getBalance` with `asOf` set, and `trialBalance`'s `asOf`
  filter, both read `occurred_at`, and a checkpoint carries no information about the dates of
  the postings it summed - it cannot answer a question keyed on a column it never looked at.
  `lowestPrefixBalance`, the overdraft prefix scan, cannot use a checkpoint either, for a
  different reason: it is a minimum over every historical prefix, and a single backdated
  entry can lower a prefix behind any watermark a checkpoint might have recorded, so there is
  no safe way to skip the postings before it. That scan is also the one running under the
  account's row lock in the entry-insert critical section, which is exactly where this design
  adds no help.
- **Nothing schedules the refresh.** `checkpointAccount` is not called from the write path;
  `scripts/checkpoint.ts` is the only caller outside tests, and nothing invokes it
  automatically. That is a real gap and a cheap one to carry: a *stale* checkpoint - one
  superseded by a later one at a higher watermark, or simply old - costs read time and never
  correctness, because `sumPostings`, the sum-from-zero path, still exists and still answers
  the same question regardless of how old the newest checkpoint is. Under `row-lock`, a
  *wrong* checkpoint - one whose watermark excluded a posting that later became permanently
  unreachable through it - is no longer possible, where it used to be before the lock was
  added. The failure mode of never running the refresh script is exactly the performance the
  system had before checkpoints existed, not a correctness regression.
- **The write path pays for a read.** `lockTouchedAccounts` locking every touched account
  rather than only the guarded, at-risk ones (see the amendment to
  `docs/adr/0004-concurrency-control.md`) is what this decision costs on every write: a
  deposit can now block another deposit to the same account, which was specifically not true
  before. That cost is paid so that `checkpointAccount`'s read has something to synchronise
  against; without the write path taking the same lock, the read side taking it alone would
  exclude nothing.
- **`serializable` cannot have this feature.** `checkpointAccount`'s refusal under that
  strategy is permanent within this design, not a gap to be closed later - see the decision
  above for why locking inside `checkpointAccount` alone cannot substitute for a lock the
  write path has already stopped taking.
- **The agreement property depends on the sum-from-zero path staying correct.**
  `tests/properties/checkpoint.property.test.ts` asserts that a checkpointed balance always
  equals the sum-from-zero balance, over arbitrary sequences of entries, reversals and
  checkpoints taken at arbitrary points in between. That test is only meaningful because
  `sumPostings` is retained as an independent, always-correct answer to compare against - the
  checkpoint path is judged against it, not the other way around, which is what makes a
  regression in the checkpoint logic detectable at all.
