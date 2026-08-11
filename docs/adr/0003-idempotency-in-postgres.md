# 3. Idempotency keys live in Postgres, not in Redis

Date: 2026-07-31
Status: accepted

Written in stage 7, after the fact. The decision was taken when
`apps/api/src/middleware/idempotency.ts` and the `idempotency_keys` table were written.

This is the boring option, and it won. The rest of this document is why, and what it costs.

## Context

`POST /books/:bookId/entries` has to be safely retryable. A client that times out does not know
whether the entry was recorded, and the only thing it can do is send the request again - so the
system has to be able to tell "this is a retry of the call I already answered" from "this is a
second, identical withdrawal", which is a distinction no amount of care in the client can make.

`external_id` already covers part of it: an entry carrying one can only be recorded once per
book. It does not cover the rest. It says nothing about calls that create nothing, and nothing
about the response - a retry of a request that was refused with a 422 gets to re-run the whole
check, and a retry of a successful call has to reconstruct the response from a fresh read. The
header answers a different question: *what did you say the first time*.

Redis is the reflexive answer to that question. It is fast, `SETNX` is one round trip, and the
TTL that expires the record is free.

## Decision

A Postgres table, `idempotency_keys`, keyed `(book_id, key)`.

The middleware inserts a reservation before the handler runs. A conflicting insert means the key
is known: if its request fingerprint - a SHA-256 over method, path and raw body - differs, that
is a client bug and answers 422 rather than replaying someone else's result; if the first
attempt has finished, its status and body are replayed; if it has not, and it started less than
a minute ago, the answer is 409. The response is captured by patching `res.json` for that one
request and written back onto the reservation on `finish`.

**The reservation is committed independently of the handler's transaction, and that is the
design rather than an accident.** The reservation exists to record *what the server answered*,
including when the server answered with a refusal. If it shared the handler's transaction it
would roll back with the failure it was recording, leaving nothing to replay and turning every
retry of a rejected request into a fresh execution of it - the exact case the header is for.

Not everything is replayed. `isReplayable` refuses two classes: a 5xx, which says the server
failed rather than that the request was refused, and `ACCOUNT_OVERDRAWN`, which is the first
outcome in this system that depends on the state of the ledger rather than on the request.
Replaying that one would pin an answer that has since stopped being true against precisely the
client doing the right thing - take the 422, deposit the shortfall the response named, retry
under the same key. The key still guarantees the withdrawal happens at most once; it is the
response, not the effect, that is allowed to differ between attempts.

## Why not Redis

- **A second datastore is a second thing to run, secure, back up, and reason about during a
  partition.** The interesting failure is not Redis being down; it is Redis being *reachable
  and stale* - restarted empty, or failed over to a replica missing the last second of writes -
  at which point a retry re-executes a write the ledger already accepted, and the ledger is the
  system of record for money.
- **The reservation and the write it guards are checked against the same database.** They are
  not in one transaction, and this document is explicit about that above - but a `SELECT` that
  finds a reservation and a `SELECT` that finds the entry it names read the same storage, with
  the same durability guarantees and the same backup. With Redis, "the key says this call
  succeeded" and "the ledger contains the entry" are two claims from two systems that can
  disagree, and reconciling them is a job somebody has to write.
- **The cost is a round trip against a database the request is about to use anyway.** The
  connection is already established and the row is a primary-key lookup.

## Consequences

- **Rows are never pruned.** `0005_auth_privileges.sql` grants `ledger_app` no `DELETE` on
  anything, so reservations accumulate forever. A TTL is exactly what Redis would have given
  for free, and this design has to grow one - a retention job, and the grant to let it run.
  Nothing schedules that today.
- **The reservation contends on the same database as the write.** Under load the idempotency
  insert competes for the same connections and the same WAL as the ledger writes it protects.
  A separate store would not, and that is the strongest thing that can be said for one here.
- **It adds a write to the write path.** One insert before the handler, one update after the
  response is sent. The update happens on `finish`, so there is a window of milliseconds where
  a retry sees an incomplete reservation and gets a 409 - which is a correct answer to "a
  request with this key is in flight", so the window costs accuracy rather than correctness.
- **A crashed process leaves a reservation nothing can complete.** `ABANDONED_AFTER_MS` is why
  it does not answer 409 forever: after a minute a later attempt assumes the first is not coming
  back and runs. Two attempts could overlap, which is a fair price for a case that only arises
  after a crash - and the ledger's own `external_id` uniqueness is what stops that overlap from
  recording the entry twice.
- **A replayed body can be stale in its mutable fields.** `EntryResource.reversedBy` is the
  first: a replayed `POST /entries` can report an entry as unreversed after something else has
  reversed it. That is the contract - retrying the same HTTP call returns the same HTTP
  response - and not a promise that the response still describes the ledger.
