# Stage 3 — HTTP layer, authentication, authorization

Status: approved 2026-07-30.

Builds on stage 1 (schema, database-enforced invariants) and stage 2 (config, ledger
service). Adds the HTTP boundary, authentication, per-book authorization, row-level
security, API keys and transport-level idempotency.

## Goals

- Seven ledger routes with correct REST semantics, plus auth, membership and API-key
  routes needed to make them reachable.
- Error responses as RFC 9457 problem documents, with the status chosen in exactly one
  place.
- argon2id passwords, short-lived access JWTs, rotating opaque refresh tokens with
  family-wide reuse detection.
- A single policy map mapping permissions to per-book roles, and a meta-test that fails
  if any registered route escapes it.
- Row-level security on `accounts`, `entries` and `postings`, keyed on a transaction-local
  setting.
- API keys for machine clients, and an `Idempotency-Key` header distinct from
  `external_id`.

## Non-goals

- Rate limiting, account lockout, password reset, email verification. Listed in
  `docs/limitations.md` at stage 7.
- Period closing. The `period:close` permission stays in the policy map with no route
  behind it; the operation is an optional extension.
- Balance snapshots, index tuning, `EXPLAIN ANALYZE`. Stage 7.
- The overdraft rule and the concurrency work. Stage 4.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Reverse and trial-balance service code | Pulled forward from stage 4 | Both routes are named in this stage. Registering a route with no implementation behind it makes the meta-test pass while proving nothing, and its tests would be written twice. Stage 4 keeps the partial unique index on `reversal_of`, the overdraft rule and the concurrency ADR. |
| argon2id implementation | `@node-rs/argon2` | Prebuilt napi binaries including win32-x64. No node-gyp, no MSVC, no CI image that needs a toolchain. |
| Access-token library | `jose`, HS256 | Zero-dependency ESM, strict `aud`/`iss`/`exp` validation by default, and no algorithm-confusion surface. One service both signs and verifies, so an asymmetric key buys nothing until a second one verifies tokens it did not issue. |
| Resolving a book from an account or entry id | `SECURITY DEFINER` lookup functions | Reading `accounts` to find the book is itself under RLS. A one-column function returning `book_id` breaks the cycle and leaks exactly one fact — which book an id belongs to — to a caller who must still pass the membership check before any data is returned. |
| `member:manage` | Backed by `POST /books/:bookId/members` | Otherwise the permission is dead code and a book has one member forever, leaving the three-role policy untestable end to end. |
| API-key issuance | `POST /books/:bookId/api-keys`, `member:manage` | Same argument. Without it, API keys can only be exercised by seeding rows, which tests the table rather than the feature. |
| `Idempotency-Key` semantics | Reserve, then cache and replay the response | A retry after a timeout gets the original status and body, which is the guarantee the header exists to provide. Genuinely distinct from `external_id`: that dedupes the entry, this dedupes the HTTP call. |
| Refresh-token storage | One table, self-referencing rotation chain | Reuse detection is a single `UPDATE ... WHERE family_id`. Keeps the whole rotation history, which is what makes a reuse incident investigable. |
| Logging | pino plus a request-id middleware, in this stage | Stage 6 surfaces `X-Request-Id` in error toasts; an id that correlates to nothing is not worth echoing. Also what makes the error middleware debuggable while it is being built. |

## Module layout

```
apps/api/src/
  http/
    app.ts               express app factory, middleware order
    problem.ts           RFC 9457 document construction
    error-middleware.ts  the one place a status code is chosen
    request-id.ts        accept inbound X-Request-Id, else generate
    logger.ts            pino, level from config, redaction
    validate.ts          zod parsing of body/params/query, failures as 400
    serialize.ts         resource serializers; bigint and Money to strings
  routes/
    registry.ts          the route table; every route declares its access
    auth.routes.ts
    books.routes.ts
    accounts.routes.ts
    entries.routes.ts
  middleware/
    authenticate.ts      Bearer JWT or lk_ API key, producing a Principal
    authorize.ts         permission to book to role to POLICY, then SET LOCAL
    idempotency.ts       reserve, replay, fingerprint check
  services/
    ledger.service.ts    extended with reverseEntry and trialBalance
    auth.service.ts      register, login, refresh, logout
    api-key.service.ts   issue, verify, touch last_used_at
    idempotency.service.ts
  repositories/
    ledger.repository.ts
    auth.repository.ts
    membership.repository.ts
    idempotency.repository.ts
  domain/
    errors.ts            extended with the new domain errors
    policy.ts            POLICY, Permission, Role
  auth/
    password.ts          argon2id hash and verify
    tokens.ts            access-token sign/verify, refresh generate/hash
```

`routes/` know Express and services, nothing else. Services know neither Express nor SQL.
`auth/` holds pure crypto with no I/O, so the service tests can substitute cheap
parameters and never pay a real argon2id hash.

## Migrations

Three migrations, not two. The repository keeps drizzle-generated SQL exactly as generated,
so the table definitions stay in a generated file and the grants move into a custom one of
their own — the same tables / privileges / rules rhythm as 0001, 0002 and 0003.

### 0004_auth.sql (generated)

Tables:

```
users            (id, email citext-ish unique, password_hash, created_at)
refresh_tokens   (id, family_id, user_id, token_hash, issued_at, expires_at,
                  redeemed_at, revoked_at, replaced_by, user_agent, ip)
book_members     (book_id, user_id, role, created_at)  primary key (book_id, user_id)
api_keys         (id, book_id, role, token_hash, prefix, name, created_at,
                  last_used_at, revoked_at)
idempotency_keys (book_id, key, request_fingerprint, status, response_body,
                  entry_id, created_at, completed_at)  primary key (book_id, key)
```

`book_role` is a Postgres enum of `owner`, `accountant`, `viewer`, mirroring the policy
map. `entries.created_by_user_id` and `entries.created_by_api_key_id`, left unconstrained
in stage 1 because the target tables did not exist, gain their foreign keys here.

### 0005_auth_privileges.sql

Grants follow 0002. `SELECT, INSERT` on all five tables, and column-level `UPDATE` on
exactly the three lifecycles that legitimately move: `refresh_tokens (redeemed_at,
revoked_at, replaced_by)`, `api_keys (last_used_at, revoked_at)`, `idempotency_keys
(status, response_body, entry_id, completed_at)`, plus `book_members (role)` so a role can
be changed. No `UPDATE` on `users` at all — password and email change do not exist yet, and
a capability granted before its feature is a capability nothing is watching. No `DELETE`
anywhere: a revoked token and a spent idempotency key are evidence, and reclaiming the
space is an operator's job run as `ledger_owner`.

### 0006_row_level_security.sql

```sql
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounts_book_isolation ON accounts
  FOR ALL
  TO ledger_app
  USING      (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid)
  WITH CHECK (book_id = nullif(current_setting('app.current_book_id', true), '')::uuid);
```

Repeated for `entries` and `postings`. `current_setting(name, true)` returns NULL rather
than raising when the setting is absent, so `book_id = NULL` is NULL, which is not true,
which is zero rows. Unset therefore fails closed without an exception. `nullif(..., '')`
covers the other shape of absent: a setting that was set and then reset within the
transaction reads back as the empty string, and `''::uuid` raises — which would turn a
missing book context into a 500 from inside a policy rather than an empty result.

The policy binds `ledger_app` because the tables are owned by `ledger_owner` and a table
owner is exempt from its own policies. That exemption is also what keeps
`assert_entry_balanced()` honest: it is `SECURITY DEFINER`, so it aggregates every posting
of the entry rather than the subset the current role may see, which migration 0003
anticipated in a comment.

`books` is deliberately left without RLS. A user must be able to list the books they
belong to before any book can be current, and that read is guarded by `book_members`.

Two lookup functions break the resolution cycle:

```sql
CREATE FUNCTION book_of_account(account_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
  AS $$ SELECT book_id FROM public.accounts WHERE id = account_id $$;
```

and `book_of_entry` likewise. `REVOKE EXECUTE ... FROM PUBLIC`, then
`GRANT EXECUTE ... TO ledger_app`. Each returns one uuid and nothing else, and is called
only by the authorization middleware.

## Transaction wrapper

`UnitOfWork` gains:

```ts
transactionInBook<T>(bookId: string, work: (tx: Executor) => Promise<T>): Promise<T>
```

which issues `select set_config('app.current_book_id', $1, true)` before the work. `SET
LOCAL` accepts no bind parameter; `set_config` with `is_local => true` is the same
statement with one, and avoids interpolating a value into SQL text.

Consequence, accepted deliberately: every book-scoped read now runs inside a transaction,
so `getBalance` and `listPostings` lose the pooled-executor fast path that stage 2's
comment defends. The setting is transaction-local, and a connection-local one on a pooled
handle would leak between requests. The `executor` handle remains for genuinely book-free
reads — user lookup, membership resolution, refresh-token rotation.

Second consequence: the book stops being implicit. `getBalance` and `listPostings` take a
`bookId` as their first argument, because the book is what the policy is keyed on and a
service method that opens a book-scoped transaction has to know which book. The HTTP layer
has already resolved it during authorization, so no second lookup is needed.

Third, and the reason two stage-2 tests changed: an account in another book is no longer
visible, so a cross-book leg raises `AccountNotFoundError` rather than
`AccountNotInBookError`. That is the better answer — the precise one confirms the existence
of a row the caller was never authorised to know about. The `bookId` comparison in
`assertPostable` stays regardless: it costs one map lookup and it is the check that still
holds if row-level security is ever off.

## Request pipeline

```
request-id
  -> pino-http
  -> json body parser
  -> cookie-parser
  -> authenticate   Bearer JWT or lk_ API key -> Principal
  -> authorize      permission -> book -> role -> POLICY -> SET LOCAL
  -> idempotency    POST only, and only when the header is present
  -> handler
  -> error middleware
```

`authorize` resolves the book from `:bookId` where the route has one, and otherwise
through `book_of_account` or `book_of_entry`. A caller who is not a member of the resolved
book receives 404, not 403: a 403 would make book membership enumerable by anyone holding
an account id. 403 is reserved for a member whose role does not carry the permission.

## Route registry and the meta-test

One table drives registration. Nothing self-registers.

```ts
{ method: 'post', path: '/books/:bookId/entries', access: { kind: 'book', permission: 'entry:post' } }
{ method: 'post', path: '/auth/login',            access: { kind: 'public' } }
{ method: 'post', path: '/books',                 access: { kind: 'authenticated' } }
```

| Method | Path | Access |
| --- | --- | --- |
| GET | /health | public |
| POST | /auth/register | public |
| POST | /auth/login | public |
| POST | /auth/refresh | public (cookie-authenticated) |
| POST | /auth/logout | public (cookie-authenticated) |
| POST | /books | authenticated |
| POST | /books/:bookId/members | `member:manage` |
| POST | /books/:bookId/api-keys | `member:manage` |
| POST | /books/:bookId/accounts | `account:create` |
| POST | /books/:bookId/entries | `entry:post` |
| GET | /books/:bookId/trial-balance | `book:read` |
| GET | /accounts/:accountId/balance | `book:read` |
| GET | /accounts/:accountId/postings | `book:read` |
| POST | /entries/:entryId/reverse | `entry:reverse` |

The meta-test walks the Express router stack, normalises each layer back to a method and
path, and asserts the two sets are equal in both directions. One direction alone would
pass an app that registers a route twice, or a registry row nothing serves.

The policy map is copied verbatim from the stage brief. There is no delete or update
permission, and none is to be added.

## Authentication

- **Password.** argon2id via `@node-rs/argon2`, parameters from config. An unknown email
  still runs a verify against a fixed dummy hash, so login timing does not distinguish
  "no such user" from "wrong password".
- **Access token.** jose, HS256, 10 minutes, claims `sub`, `iss`, `aud`, `jti`, `exp`.
  Returned in the body; the frontend holds it in memory. Never a cookie.
- **Refresh token.** 32 random bytes, base64url. Stored as HMAC-SHA256 under a pepper from
  config: the token already carries 256 bits of entropy, so argon2 would cost a slow hash
  per refresh and buy nothing a keyed hash does not. Delivered as
  `httpOnly; Secure; SameSite=Lax; Path=/auth`. `Secure` is unconditional — browsers treat
  `http://localhost` as a secure context, so development still works.
- **Rotation.** One transaction:
  `UPDATE refresh_tokens SET redeemed_at = now() WHERE token_hash = $1 AND redeemed_at IS NULL RETURNING *`.
  Zero rows means the token is unknown or already redeemed. The compare-and-swap makes two
  simultaneous refreshes resolve deterministically instead of racing.
- **Reuse detection.** A presented token that is already redeemed revokes its whole family:
  `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
  then 401. The stolen token and the legitimate one both die, which is the point — the
  legitimate holder is forced to log in again and the theft becomes visible.
- **Logout.** Revokes the family.

## Authorization

```ts
const POLICY = {
  'book:read':      ['owner', 'accountant', 'viewer'],
  'account:create': ['owner', 'accountant'],
  'entry:post':     ['owner', 'accountant'],
  'entry:reverse':  ['owner', 'accountant'],
  'period:close':   ['owner'],
  'member:manage':  ['owner'],
} as const;
```

A `Principal` is either a user (from a JWT) or an API key. An API key is scoped to one
book with one role, so for a key the role is the key's own and the book must match the
resolved book or the request is 404 by the same reasoning as a non-member.

## API keys

Format `lk_<env>_<random>`, where env is `dev`, `test` or `live`. Stored as a SHA-256 hex
hash plus a displayable prefix (the scheme, the env and the first six characters of the
random part). The plaintext is returned once, at issuance, and never again.

`last_used_at` is updated at most once a minute per key: a write on every request turns a
read-only endpoint into a write, and minute resolution is enough for the question the
column answers.

## Idempotency

`idempotency_keys` is keyed on `(book_id, key)`. The middleware inserts the row first,
which reserves the key atomically:

- Insert succeeds — the request proceeds; on completion the status and body are written
  back and `completed_at` set.
- Insert conflicts and the existing row has no `completed_at` — 409. A request with this
  key is in flight.
- Insert conflicts, the row is complete, fingerprints match — the stored status and body
  are replayed with `Idempotency-Replayed: true`.
- Insert conflicts, the row is complete, fingerprints differ — 422. The same key was used
  for a different request.

The fingerprint is SHA-256 over the canonical request body. This layer and `external_id`
are complementary: `external_id` makes posting the same entry twice a no-op regardless of
transport, while this makes retrying the same HTTP call return the same HTTP response.

## Errors

Every error response is `application/problem+json`:

```json
{
  "type": "https://ledger.local/problems/entry-unbalanced",
  "title": "Entry is unbalanced",
  "status": 422,
  "detail": "entry is unbalanced: EUR legs sum to 500",
  "instance": "/books/.../entries",
  "code": "ENTRY_UNBALANCED",
  "requestId": "...",
  "errors": [{ "path": "legs.0.amount", "message": "must not be zero" }]
}
```

| Status | Codes |
| --- | --- |
| 400 | malformed body, params or query; `INVALID_CURSOR` |
| 401 | `UNAUTHENTICATED` |
| 403 | authenticated member whose role lacks the permission |
| 404 | `BOOK_NOT_FOUND`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_IN_BOOK`, `ENTRY_NOT_FOUND`, non-member |
| 409 | `ENTRY_ALREADY_REVERSED`, idempotency key in flight |
| 422 | `ENTRY_UNBALANCED`, `ACCOUNT_CLOSED`, `CURRENCY_MISMATCH`, `IDEMPOTENCY_KEY_REUSED` |

400 and 422 split on whether the request parses: a body that does not describe an entry is
400, an entry describing an impossible fact is 422. A 500 carries a request id and nothing
else — no message, no stack, no SQLSTATE.

The mapping lives in `error-middleware.ts` and nowhere else. Domain errors continue to
carry no HTTP status, as `domain/errors.ts` already argues.

## Serialization

No global bigint hook on `JSON.stringify`. Each resource has an explicit serializer:
amounts through `formatMoney` to decimal strings, posting ids to strings, dates to ISO
8601. A response body is a value the serializer produced, never a repository row handed
straight to `res.json`.

## Testing

Real Postgres throughout, on the existing Testcontainers setup. Supertest against
`createApp()`. Nothing mocks the database.

- Each route: happy path, 401 unauthenticated, 403 under-privileged, and the specific
  failure status the route can produce.
- The route meta-test, both directions.
- RLS, exercised as `ledger_app` with direct SQL rather than through the service: no
  setting returns zero rows, the wrong book returns zero rows, the right book returns
  rows. Going through the service would prove only that the service sets the setting.
- Refresh rotation; reuse revokes the family; a revoked family cannot refresh; two
  simultaneous refreshes do not both succeed.
- API key authenticates, a key for another book is rejected, `last_used_at` advances.
- Idempotency: replay returns the original status and body, in-flight returns 409, a
  fingerprint mismatch returns 422.
- Reversal: legs negated, a second reversal is 409, a reversal of a reversal is allowed.
- Trial balance: total debits equal total credits.

## Dependencies

`express@5`, `jose`, `@node-rs/argon2`, `pino`, `pino-http`, `cookie-parser`; `supertest`
and `@types/supertest` as dev dependencies.

## Configuration

New variables, all validated in `config.ts` alongside the existing ones: the JWT secret,
issuer and audience, access-token lifetime, refresh-token pepper and lifetime, and the
argon2id parameters. Secrets have no defaults and a minimum length; the config module
refuses to boot without them, which is the existing contract. It also refuses to boot if the
JWT secret and the refresh pepper are the same value — both work perfectly well when they
are, which is exactly why nothing else would notice.

The API-key environment label (`dev`, `test`, `live`) is *derived* from `NODE_ENV` rather
than configured. Two variables that must agree are two variables that will eventually
disagree, and a key reading `lk_live_` minted by a development process is a key someone
trusts in the wrong place.
