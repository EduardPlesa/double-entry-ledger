# Limitations

What this system does not do, what that costs today, and what closing each gap would take. The
numbers come from `docs/performance.md`, taken at 500,000 postings.

## Nothing schedules a checkpoint refresh

`LedgerService.checkpointAccount` is called by `scripts/checkpoint.ts` and by tests, and by
nothing else. A book that is never checkpointed reads exactly as it did before checkpoints
existed: `getBalance` sums from zero, 13,678 buffers and 20.826 ms against a 2,500-posting
account.

**What it costs.** Read time, never correctness. `sumPostings` remains the always-correct
answer, and a stale checkpoint is one whose watermark is merely old.

**What closing it takes.** A scheduler, and a decision about what triggers a refresh - a cron
walking every account is the obvious start and the wrong one for a large book, since most
accounts have no new postings. A row counting postings since the last watermark would say which
accounts are worth revisiting, and nothing records that today.

## Checkpoints do not exist under `LEDGER_CONCURRENCY_STRATEGY=serializable`

`checkpointAccount` throws `CheckpointRequiresRowLockError` before reading anything. Under that
strategy the write path skips the account lock deliberately, so the checkpoint's read has
nothing to exclude, and SSI does not help: a checkpoint computed from a wrong watermark is a
single unclosed rw-antidependency, and SSI lets a transaction with one of those commit.

**What it costs.** The `serializable` strategy is a strictly slower system to read from, not
merely a differently-contended one.

**What closing it takes.** A separate mechanism for that strategy - an advisory lock the write
path also takes, or a watermark derived from something transactional rather than from
`nextval()`. Nobody has designed one. `docs/adr/0005-balance-checkpoints.md` records the two
inference-based designs that were tried and disproved, which is where such a design would have
to start.

## Every write locks every account its entry touches

`lockTouchedAccounts` takes `FOR NO KEY UPDATE` on every account named in an entry's legs, not
only the guarded ones the entry takes money out of. This is what makes `checkpointAccount`'s
watermark sound.

**What it costs.** A deposit can now block, and be blocked by, another write to the same
account. ADR 0004's original argument specifically noted the opposite as a property of the
narrower lock; its amendment records what changed and why.

**What closing it takes.** A checkpoint watermark that does not need writers excluded - see
above. The lock cannot narrow while the checkpoint depends on it.

## Three read paths a checkpoint cannot accelerate

`getBalance` with `asOf`, `trialBalance`'s `asOf` filter, and `lowestPrefixBalance` - the
overdraft prefix scan. The first two read `occurred_at`, and a checkpoint carries no information
about the dates of the postings it summed. The third is a minimum over every historical prefix,
and one backdated entry can lower a prefix behind any watermark.

**What it costs.** The prefix scan is the expensive one, because it runs inside the entry-insert
critical section with the account's row lock held, and again in the `LG004` trigger at COMMIT.
Under today's default `random_page_cost = 4.0` it takes **57.764 ms** with
`postings_account_id_id_idx` in place, against 21.352 ms without it - the index makes this query
slower while making every other query faster, and it ships anyway.

**What closing it takes.** For the prefix scan, either a planner-cost change
(`random_page_cost = 1.1` gets the same query to 17.132 ms, better than baseline, without
touching the schema) or an index shape that changes the cost estimate for the join rather than
only for the postings scan. Both are deployment-wide decisions, which is why neither is in a
migration. `trial-balance` aggregates every posting in the book by construction and no index
addresses that; it takes 374.505 ms and would need a different data structure, not a different
plan.

## The frontend covers the ledger and not its administration

`apps/web` has the account tree and account creation, the entry composer, the reversal flow, an
account's postings with a running balance, and the trial balance. It has no screen for granting
a member a role and none for issuing an API key, both of which the API supports. The only way to
add a second person to a book is to call `POST /books/{bookId}/members` directly.

**What it costs.** A book created through the UI is a single-user book until somebody uses curl.

**What closing it takes.** Two forms and the `member:manage` checks around them. The contracts
already exist and are published in the spec.

## An account cannot be fetched by id, so its own page cannot name it

There is no `GET /accounts/{accountId}`. The two account routes are
`/accounts/{accountId}/balance` and `/accounts/{accountId}/postings`, and neither returns the
account's name, type or currency — only its balance and its postings. `apps/web`'s account
screen is reached by id from the tree, holds nothing but that id, and so heads itself with the
word `Account` rather than `Bank`.

**What it costs.** The one screen a user lands on after clicking an account never says which
account they are looking at, and a deep link or a refresh leaves no way to find out without
going back to the tree.

**What closing it takes.** One route on the registry returning `accountResource`, which already
exists as a published schema. The authorization is the same `book:read` with `bookFrom:
'account'` the other two account routes already use, so there is no new access question — this
is a missing endpoint, not a missing design.

## The frontend's tests never meet the real API

Every test in `apps/web` runs against MSW handlers. They assert that the client sends what the
contract says and renders what the contract returns - not that the server agrees. The two ends
share `@ledger/shared`, and typechecking is what connects them.

**What it costs.** A change in behaviour that keeps its types - a status code, a header, an
ordering - passes both suites and fails in a browser.

**What closing it takes.** A Playwright run against the compose stack, which needs the API, a
migrated database and a built frontend in CI. None of that exists.

## Responses are specified but never parsed at runtime

The application does not validate what it sends. `packages/shared/src/contracts/responses.ts`
explains why, and `tests/http/contracts.test.ts` is the compensating control: it drives the real
app and parses real responses against the published schemas.

**What it costs.** A handler that drifts from the spec is caught by a test rather than by the
system. If the test is not run, or the drift is on a path the test does not exercise, the spec
is wrong and nothing says so.

**What closing it takes.** A parse in `serialize.ts` per resource, paid on every response. It
would be a real cost for a failure mode that a repository-wide typecheck already makes unlikely,
which is the trade this codebase declined.

## Idempotency reservations are never deleted

`ledger_app` has no `DELETE` grant on `idempotency_keys` - or on anything else. Every key any
client has ever sent is still in that table.

**What it costs.** Unbounded growth on a table in the write path, and a primary-key index that
grows with it.

**What closing it takes.** A retention policy, a job to enforce it, and a grant narrow enough to
let that job delete completed reservations without letting the application delete anything. The
same is true of expired refresh tokens.

## No rate limiting, no metrics, no tracing

There is a request id on every request and a structured log line per request, and that is the
whole of the operational surface. Nothing counts requests, nothing measures latency, and nothing
stops a client from sending as many as it likes - including at `POST /auth/login`, where the
cost per request is a deliberately expensive argon2 hash.

**What closing it takes.** A rate limiter in front of the auth endpoints at minimum, and a
metrics exporter. The `route-audit` registry is the natural place to hang per-route limits,
since it already enumerates every route.

## No down migrations

`drizzle/` contains forward migrations only. Rolling back a schema change means restoring a
database.

**What it costs.** A bad migration is an incident rather than a `git revert`.

**What closing it takes.** Reversible migrations, and the discipline that comes with them. Some
of these are not reversible in any useful sense - `0003_invariants.sql` establishes rules that
existing data may violate the moment they are dropped.

## One currency per account, and no FX

An account has a currency; a posting must match it; an entry must balance per currency. There is
no rate table, no revaluation, no gain-or-loss accounting, and a "transfer" between accounts in
different currencies is not expressible.

**What closing it takes.** A rate source, a decision about which rate applies at which instant,
and the accounting for the difference. That is a larger design than everything in this repository
so far.

## Sessions cannot be listed or revoked individually

Refresh tokens rotate and reuse is detected - presenting a rotated token kills the whole family.
But there is no way to ask which devices have a live session, and no way to end one without
ending all of them.

**What closing it takes.** A read model over `refresh_tokens` grouped by family, and an endpoint
that revokes a family by id. The rows already carry the user agent and IP.

## CI verifies and does not deploy

`.github/workflows/ci.yml` runs typecheck, lint and the test suites, and checks that a small
seed still runs against the current schema. It does not build an image, does not publish
anything, and does not deploy. The 500,000-posting numbers in `docs/performance.md` are taken by
hand, because a timing threshold on a shared runner measures the runner.

## `/docs` needs the internet; `docs/openapi.json` does not

The HTML page loads Scalar from a CDN, so it renders as a blank page on a machine with no
outbound network. The document it renders is served from `/docs/openapi.json` and committed at
`docs/openapi.json`, and neither needs anything.
