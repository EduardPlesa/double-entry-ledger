# Testing

Four kinds of test, split into four Vitest projects (`apps/api/vitest.config.ts`). `unit` is
pure computation and needs nothing but Node. `integration` and `concurrency` need a real
Postgres, started per run through Testcontainers. `properties` needs the same database and a
budget of tens of seconds rather than one.

The split is not tidiness. A single project means a global setup that starts a container on
every run, so checking whether a regex is right requires Docker to be up - and a test suite you
cannot run is a test suite that stops being run.

## Property-based tests

The example suites pin the cases someone thought of. `apps/api/tests/properties/` states the
same invariants as fast-check properties and lets the generator look for the cases nobody
thought of — against the real database, because half of what this project asserts is enforced in
migrations rather than in TypeScript.

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

## The checkpoint agreement property

`apps/api/tests/properties/checkpoint.property.test.ts` asserts one thing over arbitrary
sequences of entries, reversals and checkpoints taken at arbitrary points in between: the
balance computed through a checkpoint equals the balance computed by summing from zero.

That property is only meaningful because the sum-from-zero path is retained as an independent,
always-correct answer to compare against — the checkpoint is judged against it, never the other
way around. It is also the test that would catch the failure `docs/adr/0005-balance-checkpoints.md`
is mostly about: a watermark that excludes a posting which later becomes permanently unreachable
through it produces a balance that is short by exactly that posting, silently, with no
constraint violated anywhere.

## What the properties found

An amount above `2^63 − 1` — the ceiling of the `bigint` column that stores minor units — passes
every validation layer and then answers **HTTP 500**. `amount` is typed only as a string,
`parseMoney` checks decimal shape and non-zero but never magnitude, and no domain error covers the
case, so the request reaches the error middleware's catch-all and is logged as an unanticipated
bug. That middleware special-cases malformed JSON precisely because it would otherwise be "a 500
for what is unambiguously a client mistake"; an out-of-range amount is the same category and gets
none of the same treatment. From the caller's side it is indistinguishable from a server fault.

No example test would have found it, because nobody writes `9223372036854775808` by hand. The
generator did, on its first run. The boundary property is bounded at the real ceiling meanwhile,
with the reason stated at the constant.

## The corpus

`apps/api/tests/properties/regressions.ts` holds counterexamples this suite has found,
transcribed and replayed on every run through fast-check's `examples` option — which, unlike a
recorded seed, states what it defends against and survives the generators being rewritten.

It is currently empty, and deliberately so. The one defect above cannot be expressed as an entry:
the generator is now bounded below that ceiling, and a case the generator cannot produce cannot be
replayed. Nothing was planted here to demonstrate the mechanism.

## Query counting

`apps/api/tests/services/query-count.test.ts` measures the statements a read path actually sends,
counting at the driver rather than through the ORM — `BEGIN`, `set_config` and `COMMIT` are round
trips too. It asserts that `listPostings` sends the same statements for a page of 1 as for a page
of 50, and that the trial balance is invariant to how many accounts a book has.

An N+1 returns exactly the right answer, just once per row, so it is invisible to every other test
here. The exact counts are pinned beside the invariance assertions, with each statement named, so
that replacing one is a deliberate edit rather than a silent drift.

## The route meta-test

`apps/api/tests/http/routes.meta.test.ts` enumerates what Express actually has registered and
compares it against `routes/registry.ts` in both directions. A route with no declared permission
does not fail closed — it works, returns data, and looks like every other route — so this is the
only place it can be caught. `tests/unit/route-audit.test.ts` is what makes that meaningful: it
proves the audit detects a smuggled route, a stale registry row, a double registration and a
mounted sub-router.

The same file asserts that every non-public route declares the schemas its handler parses, which
is what keeps the published OpenAPI document honest.

## Contract tests

`apps/api/tests/http/contracts.test.ts` drives the real application and parses real responses
against the schemas the spec publishes. The application does not validate its own responses, so
this is the compensating control: a handler that adds a field or serialises an amount as a number
fails here rather than in a client.

`apps/api/tests/http/openapi.test.ts` additionally compares the generated document against the
committed `docs/openapi.json`, so a spec that is out of date is a failed test rather than a
surprise.

## The frontend

Every test in `apps/web` runs against MSW handlers except one. `apps/web/e2e/ledger.spec.ts`
runs against the real API and a real Postgres, because the dev proxy forwarding paths verbatim,
the refresh cookie's `Path=/auth` surviving that, and the silent refresh at boot that keeps a
reload signed in are exactly the things a mock cannot reach — the browser, the proxy and the
cookie jar all have to actually be there.

What that leaves uncovered is in [limitations.md](limitations.md): the component tests assert
that the client matches the contract, not that the server does.
