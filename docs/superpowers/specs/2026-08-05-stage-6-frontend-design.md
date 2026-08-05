# Stage 6 — the frontend

Status: approved 2026-08-05.

Five stages have built a ledger with no way to look at it. This stage gives it one: React 19 on
Vite, TanStack Query for server state, React Hook Form with Zod for the forms, Tailwind for the
styling. Five screens, in the order the brief names them, with the entry composer first because
it is the only one that writes.

Two things make this more than wiring. The first is that the schemas the brief says to import
from `packages/shared` are not there — they live in `apps/api/src/services/*.ts`, so this stage
begins by moving them, which makes the zero-sum rule the composer gates on and the zero-sum rule
the service enforces the same object rather than two copies. The second is that three screens
need read endpoints the API does not have, so this stage adds them.

## Goals

- An entry composer where legs are added and removed freely, the imbalance is stated in words
  and in money as it is typed, and submit is impossible until every currency sums to zero.
- Account tree with balances, account detail with paginated postings and their running balance,
  trial balance, and a reversal flow that shows what it will do before it does it.
- One definition of every request shape, in `packages/shared`, imported by both sides.
- Every user-visible failure carrying the `X-Request-Id` that finds it in the structured logs.
- A session that survives a page reload without a script-readable credential.

## Non-goals

- Member and API-key administration. Both endpoints exist and neither gets a screen; nothing in
  the five the brief names needs one, and a permissions UI is its own design problem.
- Optimistic updates. Discussed under "Why nothing is optimistic" — this is a decision, not an
  omission.
- Dark mode, i18n, CSV export, charts, period close.
- Indexes, checkpoints, OpenAPI, CI. Stage 7.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where request schemas live | Moved to `packages/shared`, imported by `apps/api` | The composer's submit gate *is* `postEntryInput`'s zero-sum rule. Two copies of it can disagree, and the version that disagrees silently is the client's — it would grey out submit on entries the server would have accepted, or offer submit on entries it will refuse. One definition removes the possibility. Only shape rules move; anything needing a database stays in the service. |
| Where response contracts live | TypeScript types in `packages/shared`, no runtime parse | Response Zod would catch a server-side shape change in the client at the boundary rather than as `undefined` in a cell. It costs a schema per resource and a parse per response, against a server in the same repository, typechecked in the same command. The amounts are parsed either way — `parseMoney` throws on anything that is not a decimal string — so the field most likely to be wrong is already validated. |
| The missing reads | Three new `GET`s, landed before any frontend work | Screen 2 needs `parentId`, which trial-balance does not carry; screen 5 needs the entry it is about to reverse; nothing after login knows which books the caller has. Each is a registry row, a `book:read`, and a repository method, one of which already exists. Working around them client-side means a flat "tree", a book id pasted by hand, and a reversal with no preview. |
| How a leg is entered | Debit and credit columns, mapped to a signed amount at submit | The API takes one signed amount per leg and that is the right boundary, but nobody who keeps books enters a journal as a column of positive and negative numbers, and a stray minus sign is invisible. Two columns make the direction structural. The cost is a mapping layer and a rule that a row cannot fill both. |
| Where the preview's numbers come from | The client, from the entry and one trial-balance call | One request regardless of leg count. A server-side dry run would have to execute the write path and roll it back to learn anything the client cannot compute, and the one thing it would learn — whether the overdraft rule accepts — is stale the moment it is returned. See "What a preview can and cannot promise". |
| Where the access token lives | In memory, never `localStorage` | `http/cookies.ts` already argues this for the refresh token: a credential a script can read is a credential XSS takes. The refresh cookie survives a reload and the access token does not, so boot does one silent refresh. |
| How the browser reaches the API | Vite proxy, paths verbatim, no `/api` prefix | The API has no CORS middleware, so the app must be same-origin. The prefix is not a style question: the refresh cookie is `Path=/auth`, and mounting the API under `/api` means the browser never sends it to `/api/auth/refresh` and every session dies at its first refresh, silently. |
| Router | React Router v7, declarative | Five screens and one dynamic segment each. TanStack Router's typed params would be welcome and would also be a second routing abstraction imported for a route table that fits on a screen. The boring option. |
| What the web suite runs against | RTL over MSW, plus one Playwright path against the real API | Handlers written by the same person who wrote the client agree with the client by construction. What they cannot cover is the proxy, the cookie path, and boot refresh — precisely the wiring this design has the most subtle failure modes in — so one real path exercises them. |

## The contract package

`packages/shared` gains `zod` and two modules:

`src/contracts/requests.ts` — `credentials`, `createBookInput`, `createAccountInput`,
`postEntryInput`, `reverseEntryInput`, `paginationQuery`. These are moved, not copied:
`auth.service.ts`, `book.service.ts` and `ledger.service.ts` delete their local `z.object`
declarations and import these instead. `http/validate.ts` keeps `parseOrThrow`, `uuidParam` and
`uuidPathParam`, which are about the HTTP boundary rather than about a request body.

`src/contracts/responses.ts` — the four interfaces `http/serialize.ts` currently declares
(`EntryResource`, `BalanceResource`, `TrialBalanceResource`, `PostingPageResource`), plus
`BookResource` and `AccountResource` for the new endpoints. The serializer functions stay where
they are and import their return types.

The split `validate.ts` documents survives intact. Shared schemas answer "is this JSON shaped
like the thing it claims to be", which is the 400. Whether the account is open, whether the
currencies match, whether the entry overdraws anything remains in the service against a
database, which is the 422. Moving the first half does not move the second.

## The three new endpoints, and two additions

All three are `book:read`, which every role carries — a viewer can use the whole application.

| Route | Book from | Backing |
| --- | --- | --- |
| `GET /books` | none; `authenticated` | New `listBooksForUser` on `membership.repository`. An API-key principal is scoped to one book and gets that one. |
| `GET /books/:bookId/accounts` | `param` | New `listAccountsByBook` on `ledger.repository`. |
| `GET /entries/:entryId` | `entry` | `findEntryById` exists; `BookSource: 'entry'` exists. |

`AccountResource` carries `parentId` and `closedAt`, which is what makes screen 2 a tree rather
than the flat list trial-balance already returns.

Two additions to existing shapes:

`BookResource` carries the caller's `role`. Without it the client has to offer every action to
every member and discover the refusals, so a viewer sees a compose button that always fails.
With it the UI declines to offer what `domain/policy.ts` forbids, while the server keeps
enforcing it — the client stops asking, it does not start deciding.

`EntryResource` carries `reversedBy`. It already carries `reversalOf`, the link in the other
direction; without the inverse the reversal screen cannot know an entry has already been
reversed and can only find out by posting and reading `ENTRY_ALREADY_REVERSED` off the failure.
`findReversalOf` already exists in the repository, so this is a serializer field and a join.

## The client

Every request goes through one `apiFetch`. It attaches the bearer token, parses failures, and
owns the two behaviours that must not be reimplemented per call site:

**Idempotency.** Book-scoped POSTs carry an `Idempotency-Key`, generated once per composer
session and *held across retries* — a retry that generates a new key is not a retry, it is a
second request, which is the exact failure the header exists to prevent. A new key is minted
only after a success.

**Refresh.** A 401 triggers one `POST /auth/refresh` and one retry of the original request. At
most one refresh is ever in flight; concurrent 401s wait on the same promise. A second failure
clears the session and routes to login, preserving where the user was going. No other 4xx is
retried.

Failures become an `ApiError` carrying `code`, `status`, `requestId` and `errors[]`, read from
the `problem+json` body. The request id is taken from the body rather than the `X-Request-Id`
header, which needs no `Access-Control-Expose-Headers` and is one fewer thing to get wrong when
this eventually runs cross-origin.

Money never becomes a `number` here either. Inputs are strings, arithmetic is `parseMoney`,
`sumMoney` and `negateMoney` from `packages/shared`, display is `formatMoney`, and the
composer's balance check compares bigints.

## The screens

### 1. Entry composer — `/books/:bookId/entries/new`

`useFieldArray` over the legs, two rows minimum. A row is an account combobox, a debit cell, a
credit cell, and a currency badge that is *derived* from the chosen account rather than chosen —
an account holds exactly one currency, which `accounts_id_book_id_currency_key` makes a fact
about the database rather than a convention.

Above submit, a strip groups the legs by currency and states each imbalance:

```
EUR   debits exceed credits by 4.20
USD   balanced
```

Zero-sum is per currency, so this is a list and not a number. Submit enables only when every
group is exactly zero and: two or more legs; every row has an account; no row fills both columns;
no row fills neither; no row amounts to zero, because `postings_amount_nonzero` rejects a leg
that carries no information and discovering that at the server is a round trip spent on a typo;
description non-blank.

One affordance beyond the brief: **balance onto this row**, which fills an empty amount cell with
the outstanding delta in that row's currency. It is the operation people perform by hand on every
journal they have ever written.

Header fields are `occurredAt`, defaulting to now and freely backdated, `description`, and an
optional `externalId`. Debits map to positive minor units and credits to negative, at submit.

`201` and `200` are reported differently. A `200` means an entry with that `externalId` already
existed and this request recorded nothing; calling that "created" would be false, and the
distinction is the only way a caller can tell what happened without diffing bodies. On success,
invalidate the trial balance, the accounts list, and the postings of every affected account.

A fresh book has no accounts, so a create-account form lives beside the composer. A fresh user
has no book, so a create-book form lives in the empty state after register. Neither is one of the
five screens and both are required for the five to be reachable.

### 2. Account tree — `/books/:bookId/accounts`

Two requests — accounts for the hierarchy, trial balance for the balances — joined on
`accountId`. Not one balance request per account: the trial balance is a fixed number of queries
regardless of how many accounts a book has, which `query-count.test.ts` asserts, and an N+1 in
the client would give that away for nothing.

A parent shows its own balance and, where it has children, a subtree total per currency. Never
one total across currencies: a subtree holding EUR and USD accounts shows two lines, because the
sum of the two is not a number this system is willing to invent. Closed accounts dim, with a
toggle to hide them.

### 3. Account detail — `/accounts/:accountId`

`useInfiniteQuery` keyed on the account, with `nextCursor` as the page param. The running balance
is the server's column, rendered as received. Recomputing it client-side would create a second
authority on the `(occurred_at, id)` ordering — the same ordering the property suite checks twice,
once through a window function and once through an array scan, precisely because that tiebreaker
is where a disagreement would hide.

The header shows the current balance with an `asOf` picker, which is a question about
`occurred_at` and therefore answers differently once something is backdated. Rows link to their
entry.

### 4. Trial balance — `/books/:bookId/trial-balance`

`asOf` lives in the URL query, so a view is a link someone can send. Accounts stay in the order
the server returned them — by type, then name — and type headings are inserted while walking the
list, which is what `serialize.ts` says that ordering is for.

Per-currency totals show debits, credits and `balanced`. A `balanced: false` is a failure banner,
not a grey cell: it means invariant 1 has been violated in a system with a deferred constraint
trigger that exists to make that impossible.

### 5. Reversal — `/entries/:entryId/reverse`

`GET /entries/:entryId` for the legs, trial balance for current balances, subtracted per account:

```
Cash               1,200.00  →  1,150.00   (−50.00)
Office supplies       50.00  →      0.00   (−50.00)
```

`reversedBy` disables the action for an entry already reversed, rather than offering an operation
whose only possible outcome is `ENTRY_ALREADY_REVERSED`.

Confirmation posts with an `Idempotency-Key`. `ACCOUNT_OVERDRAWN` is handled there.

#### What a preview can and cannot promise

It can promise arithmetic: the delta is the negation of each original leg, and that is exactly
what the reversal will post. It cannot promise acceptance. Reversals are not exempt from the
overdraft rule — an entry that cannot be reversed without leaving a guarded account negative is
an entry whose reversal alone is not the correction — and the rule is evaluated against the state
at commit, over every prefix of the account's history, which another writer may have moved since
the preview was drawn.

So a projected negative on a guarded account renders as "the server may refuse this", and the
screen does not pretend to know more than it does.

## Errors

The toast carries `requestId` in monospace with a copy button, which is the stage's stated
requirement: a user reads out one string and it finds their failure in the logs. A failure with
no response at all — the network, not the server — gets a toast that says there is no request id,
rather than an empty field, which reads as an answer.

Not every problem is a toast:

- `VALIDATION_FAILED` maps `errors[]` back onto form fields by `path`. Server paths are
  `postings.N.amount`; the form has two columns, so the mapper resolves `N` to whichever column
  that row filled. Field-level, no toast.
- `ACCOUNT_OVERDRAWN` carries `accountId`, `shortfall` and `occurredAt` as extension members, so
  the toast names the account, the amount that has to be deposited first, and the date the
  balance first goes short. All three are null when the LG004 trigger raised it rather than the
  application check, and that path degrades to "rejected at commit" rather than rendering `null`.
- `ENTRY_UNBALANCED` should be unreachable, because the client gates on it. Receiving it means
  the client's arithmetic and the server's disagree, and the toast says that instead of blaming
  the user.
- `IDEMPOTENCY_KEY_IN_FLIGHT` offers a retry that reuses the same key.
- `FORBIDDEN` should be unreachable too, because `BookResource.role` lets the UI stop offering
  what the policy forbids.

Toasts are a local `ToastRegion` with a queue and an `aria-live` region. No dependency for that.

## Why nothing is optimistic

TanStack Query makes optimistic updates easy, and this application should not have them. The
overdraft rule means the server may genuinely refuse a write the client believes is fine, and
the rule depends on history the client has not read. An optimistic ledger shows a posting that
was rejected, and then takes it back — which in a system whose entire premise is that history is
append-only and balances are derived rather than stored is the one lie it must not tell. A
spinner is worse UX and better accounting.

## Order

1. Extract the contracts to `packages/shared`; the API imports them. No behaviour change, and the
   existing suites staying green is the proof.
2. The API additions: three `GET`s, `reversedBy`, `role`. Registry rows, the route meta-test, the
   permission tests.
3. Web scaffold: Vite, Tailwind, router, `apiFetch`, session, login, register, book picker,
   create-book.
4. The composer, with create-account beside it.
5. Account tree.
6. Account detail.
7. Trial balance.
8. Reversal.
9. The Playwright path.

Steps 1 and 2 are API work in a frontend stage, and they come first because every screen after
step 3 depends on one or both.

## Tests

RTL over MSW, with handlers typed by the shared response types. The composer suite covers the
per-currency indicator, each submit-gate condition, zero-amount rejection, balance
onto row, the `200`-versus-`201` wording, and server field errors landing on the right row and
column. The `apiFetch` suite covers refresh-once-then-retry, one refresh in flight at a time, the
key held across retries, and the problem parse.

One Playwright path against the real API on a Testcontainers Postgres: register, create a book,
create two accounts, post a balanced entry, see it in the tree, confirm the trial balance is
balanced, reverse it, see the balances return. It is the only test that touches the proxy, the
cookie path and boot refresh, which is why it exists and why one is enough.

`apps/web/package.json`'s stub `test` and `typecheck` scripts are replaced, so `pnpm -r test` and
`pnpm typecheck` pick the web project up without either being edited.

## Files

New:

```
packages/shared/src/contracts/requests.ts
packages/shared/src/contracts/responses.ts
apps/web/vite.config.ts
apps/web/tailwind.config.ts
apps/web/index.html
apps/web/src/api/client.ts                 apiFetch, ApiError, refresh, idempotency
apps/web/src/api/keys.ts                   the query key factory
apps/web/src/session/                      in-memory token, boot refresh, route guard
apps/web/src/components/ToastRegion.tsx
apps/web/src/routes/                       login, register, books, composer, tree,
                                           account detail, trial balance, reversal
apps/web/tests/                            RTL suites, MSW handlers
apps/web/e2e/ledger.spec.ts
```

Modified:

```
packages/shared/package.json               zod
apps/api/src/services/auth.service.ts      imports the shared schemas
apps/api/src/services/book.service.ts      imports the shared schemas
apps/api/src/services/ledger.service.ts    imports the shared schemas
apps/api/src/repositories/membership.repository.ts   listBooksForUser
apps/api/src/repositories/ledger.repository.ts       listAccountsByBook
apps/api/src/http/serialize.ts             imports the shared types; reversedBy
apps/api/src/routes/books.routes.ts        GET /books, GET /books/:bookId/accounts
apps/api/src/routes/ledger.routes.ts       GET /entries/:entryId
apps/web/package.json                      real scripts, real dependencies
README.md                                  the frontend, and the proxy's cookie constraint
```
