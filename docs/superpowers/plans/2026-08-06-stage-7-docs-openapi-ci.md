# Stage 7, plan 3 — the spec, the record, and the pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An OpenAPI 3.1 spec generated from the Zod schemas and served at `/docs`, a README whose opening is true, five ADRs, an honest limitations list, and GitHub Actions running typecheck, lint and test on every push.

**Architecture:** Response shapes become Zod schemas so the spec has something to describe; the route registry gains schema fields and the handlers parse through them, so declared and enforced are one value. A generator walks the registry and derives security, the `Idempotency-Key` header and the error responses from `access` — nothing about a route is stated twice. The generated document is committed and diffed in CI.

**Tech Stack:** Zod 4 (`z.toJSONSchema`), Express 5, Vitest 4, GitHub Actions, pnpm 11, Node 22.

## Global Constraints

- Prerequisites: plans 1 and 2 are merged. The README's Decisions & Tradeoffs section links `docs/performance.md`, and ADR 0005 quotes it.
- No new runtime dependency. Zod 4 is already here and converts to JSON Schema natively; OpenAPI 3.1's schema dialect *is* JSON Schema 2020-12.
- No runtime response validation in the application. Response schemas exist so the spec and the TypeScript types come from one source; parsing them happens in tests.
- Every route reaches the app through `routes/registry.ts`. `tests/http/routes.meta.test.ts` enforces that; `/docs` is not an exception.
- Money is decimal strings on the wire, posting ids are strings, timestamps are ISO 8601 with an offset — `src/http/serialize.ts` is the authority, and the schemas must agree with it.
- ADR headings follow `docs/adr/0004-concurrency-control.md`: Date, Status, Context, Decision, Consequences.
- Comments and prose match the surrounding voice. State the cost of a decision, not only its benefit.

## File Structure

**Create:**
- `apps/api/src/openapi/document.ts` — the generator.
- `apps/api/src/openapi/security.ts` — schemes and per-route requirements, derived from `access`.
- `apps/api/src/routes/docs.routes.ts` — the two public routes.
- `apps/api/scripts/openapi.ts` — writes `docs/openapi.json`.
- `apps/api/tests/http/openapi.test.ts` — the served spec, and the drift check.
- `apps/api/tests/http/contracts.test.ts` — real responses parse against the response schemas.
- `docs/openapi.json`, `docs/limitations.md`, `docs/testing.md`, `docs/database.md`
- `docs/adr/0001-invariants-in-the-database.md`, `0002-money-as-minor-units.md`, `0003-idempotency-in-postgres.md`, `0005-balance-checkpoints.md`
- `.github/workflows/ci.yml`

**Modify:**
- `packages/shared/src/contracts/responses.ts` — Zod-first.
- `packages/shared/src/index.ts` — export the schemas.
- `apps/api/src/routes/registry.ts` — schema fields on `RouteDefinition`.
- `apps/api/src/routes/*.routes.ts` — parse through the row's schemas.
- `apps/api/src/routes/index.ts` — include the docs routes.
- `apps/api/tests/http/routes.meta.test.ts` — every non-public route declares its schemas.
- `README.md`

---

### Task 1: Response shapes become schemas

**Files:**
- Modify: `packages/shared/src/contracts/responses.ts`, `packages/shared/src/index.ts`
- Test: `apps/api/tests/http/contracts.test.ts`

**Interfaces:**
- Produces, from `@ledger/shared`: `bookResource`, `accountResource`, `entryResource`, `balanceResource`, `trialBalanceResource`, `postingPageResource` (Zod schemas), and the existing type names as `z.infer` of each — `BookResource`, `AccountResource`, `EntryResource`, `BalanceResource`, `TrialBalanceResource`, `PostingPageResource`, unchanged in name and in shape.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/http/contracts.test.ts`. It drives the real app through supertest — copy the harness from `tests/http/ledger.test.ts`.

```ts
/**
 * Every response this API sends parses against the schema the spec publishes for it.
 *
 * The application does not parse its own responses - `responses.ts` explains why, and that
 * argument still holds. This is where the schemas get verified instead: if a handler adds a
 * field, or serialises an amount as a number, the spec is wrong and this fails. Without it
 * the schemas would be a second declaration of the same shape, free to drift from the first.
 */

it('GET /books returns books that parse', async () => {
  const response = await request(app).get('/books').set(auth);

  expect(response.status).toBe(200);
  expect(() => z.array(bookResource).parse(response.body)).not.toThrow();
});
```

Write one case per resource: books, accounts, an entry, a balance, a trial balance, a page of postings. Use the seeding helpers the sibling HTTP tests already use; do not invent new ones.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api test tests/http/contracts.test.ts
```

Expected: FAIL — `bookResource` is not exported.

- [ ] **Step 3: Invert `responses.ts`**

Rewrite each interface as a schema, keeping the field documentation as `.describe()` so it reaches the spec, and keeping the file's opening comment — amended, not deleted. It currently argues "types, not schemas"; the amendment says what changed: the shapes are values now so the spec can describe them, and the argument against parsing them *in the application* is unchanged.

```ts
export const bookResource = z.object({
  id: z.uuid(),
  name: z.string(),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  createdAt: z.iso.datetime({ offset: true }),
  role: z.enum(BOOK_ROLES).describe(
    'The caller\'s role in this book. Present so the UI can stop offering what the policy forbids.',
  ),
});

export type BookResource = z.infer<typeof bookResource>;
```

Amounts are decimal strings: define one shared `moneyString` schema in this file (or next to `money.ts` if that fits better) with a regex matching what `serialize.ts` emits, and use it everywhere an amount appears. Same for `postingId` — a string, because a bigserial outruns `Number.MAX_SAFE_INTEGER`.

Every type name and every field name stays exactly as it is. This task changes how the shapes are declared, not what they are.

- [ ] **Step 4: Export the schemas**

Add them to `packages/shared/src/index.ts` alongside the existing type exports.

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ledger/api test tests/http/contracts.test.ts
```

Expected: PASS. A failure here is a real disagreement between the handler and the schema — fix the schema to match what the handler sends, unless the handler is wrong, in which case say so and fix that.

- [ ] **Step 6: Typecheck the workspace**

```bash
pnpm typecheck
```

Expected: clean, including `@ledger/web`. If `z.infer` produced a subtly different type than the interface did — optional versus `| null`, a widened enum — reconcile it in the schema. Do not add a cast at a call site.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/contracts/responses.ts packages/shared/src/index.ts apps/api/tests/http/contracts.test.ts
git commit -m "refactor(shared): response shapes become schemas, so a spec can describe them"
```

---

### Task 2: The registry carries the schemas

**Files:**
- Modify: `apps/api/src/routes/registry.ts`, `apps/api/src/routes/auth.routes.ts`, `books.routes.ts`, `ledger.routes.ts`
- Test: `apps/api/tests/http/routes.meta.test.ts`

**Interfaces:**
- Produces, on `RouteDefinition`:

```ts
  readonly request?: {
    readonly params?: z.ZodType;
    readonly query?: z.ZodType;
    readonly body?: z.ZodType;
  };
  /** The 2xx body. The status it is returned with. */
  readonly response?: { readonly status: number; readonly schema: z.ZodType };
```

- [ ] **Step 1: Write the failing test**

In `apps/api/tests/http/routes.meta.test.ts`, add:

```ts
it('every route that takes a body declares its schema', () => {
  const missing = definitions.filter(
    (definition) => definition.method === 'post' && definition.request?.body === undefined,
  );

  expect(missing.map((definition) => `${definition.method} ${definition.path}`)).toEqual([]);
});

it('every route that returns a resource declares its schema', () => {
  const missing = definitions.filter(
    (definition) => definition.access.kind !== 'public' && definition.response === undefined,
  );

  expect(missing.map((definition) => `${definition.method} ${definition.path}`)).toEqual([]);
});
```

The list of definitions comes from wherever this test already gets it — read the file first.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api test tests/http/routes.meta.test.ts
```

Expected: FAIL, listing every route.

- [ ] **Step 3: Add the fields to `RouteDefinition`**

With a comment explaining the constraint that makes them worth having: the handler parses through *this* object, so a schema in the spec that a handler does not enforce is not representable.

- [ ] **Step 4: Fill in every row, and route the handlers through them**

For each definition, add the schemas it already uses — `postEntryInput`, `paginationQuery`, `createAccountInput`, and so on — and change the handler to parse the row's schema rather than an imported one. Where a handler currently calls `parseOrThrow(paginationQuery, ...)`, it now reads the schema from the definition it belongs to.

Path parameters: `uuidPathParam` stays as the enforcement, and the row declares the shape (`z.object({ bookId: z.uuid() })`) so the spec can list the parameter. Say so in a comment — this is the one place where the declaration and the enforcement are two expressions, and the reason is that the guard resolves the book from the path before the handler runs.

- [ ] **Step 5: Run the whole HTTP suite**

```bash
pnpm --filter @ledger/api test tests/http
```

Expected: PASS, including the two new meta assertions.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes apps/api/tests/http/routes.meta.test.ts
git commit -m "refactor(routes): a row declares the schemas its handler parses"
```

---

### Task 3: The generator

**Files:**
- Create: `apps/api/src/openapi/document.ts`, `apps/api/src/openapi/security.ts`
- Test: `apps/api/tests/http/openapi.test.ts`

**Interfaces:**
- Consumes: `RouteDefinition[]`, `acceptsIdempotencyKey`.
- Produces: `buildOpenApiDocument(definitions: readonly RouteDefinition[]): OpenApiDocument`, and `securitySchemes` / `securityFor(access)` from `security.ts`.

- [ ] **Step 1: Learn what the app actually accepts**

Read `src/http/context.ts`, `src/middleware/authorize.ts` and `src/http/cookies.ts` and write down the exact credential shapes: the access-token cookie's name, and the API-key header's name. The spec declares those, verbatim. Do not invent a scheme name that no middleware reads.

- [ ] **Step 2: Write the failing test**

Create `apps/api/tests/http/openapi.test.ts`:

```ts
describe('the generated document', () => {
  it('has a path for every registered route', () => {
    const document = buildOpenApiDocument(definitions);

    for (const definition of definitions) {
      // Express ':bookId' is OpenAPI '{bookId}'.
      const path = definition.path.replace(/:(\w+)/g, '{$1}');
      expect(document.paths[path]?.[definition.method]).toBeDefined();
    }
  });

  it('requires no credential on a public route and one everywhere else', () => {
    const document = buildOpenApiDocument(definitions);
    const login = document.paths['/auth/login']?.post;
    const entries = document.paths['/books/{bookId}/entries']?.post;

    expect(login?.security).toEqual([]);
    expect(entries?.security?.length).toBeGreaterThan(0);
  });

  it('documents Idempotency-Key on exactly the routes that honour it', () => {
    const document = buildOpenApiDocument(definitions);

    for (const definition of definitions) {
      const path = definition.path.replace(/:(\w+)/g, '{$1}');
      const parameters = document.paths[path]?.[definition.method]?.parameters ?? [];
      const declared = parameters.some((parameter) => parameter.name === 'Idempotency-Key');

      expect(declared, `${definition.method} ${definition.path}`).toBe(
        acceptsIdempotencyKey(definition),
      );
    }
  });

  it('describes the problem shape once and references it', () => {
    const document = buildOpenApiDocument(definitions);

    expect(document.components.schemas.Problem).toBeDefined();
    expect(document.paths['/books/{bookId}/entries']?.post?.responses['422']).toBeDefined();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @ledger/api test tests/http/openapi.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write `security.ts`**

The schemes learned in Step 1, plus:

```ts
/**
 * What a route requires, derived from what it declares.
 *
 * The registry already knows: `public` needs nothing, `authenticated` needs a token, `book`
 * needs a token and a permission the token's holder has in that book. OpenAPI cannot express
 * the permission - it has no vocabulary for "editor in the book named by this path" - so the
 * permission goes in the operation's description, where a human reads it, rather than being
 * silently dropped.
 */
```

- [ ] **Step 5: Write `document.ts`**

It walks the definitions and emits `openapi: '3.1.0'`, `info`, `paths`, `components`. Conversions:

- Express `:param` → `{param}`; each path parameter is `required: true`.
- `request.query` → one `query` parameter per key of the object schema.
- `request.body` → `requestBody.content['application/json'].schema`, converted with `z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })`.
- `response` → `responses[status].content['application/json'].schema`, converted with `io: 'output'`.
- Error responses from `access.kind`: 401 for anything not public, 403 and 404 for `book` routes (404 is the non-member answer — say so in the description, because it looks like a bug otherwise), 400 wherever a schema parses, 422 on writes. Each `$ref`s `#/components/schemas/Problem`.
- `Problem` is written by hand in `document.ts` against RFC 9457 and `src/http/problem.ts`. Keep them next to each other in the file so drift is visible.

Prefer Zod's registry so shared schemas become `$ref`s rather than being inlined at every use. If the installed Zod's registry API does not support it cleanly, inline them and leave a comment saying that is why — an inlined schema is verbose, not wrong.

- [ ] **Step 6: Run the test and watch it pass**

```bash
pnpm --filter @ledger/api test tests/http/openapi.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/openapi apps/api/tests/http/openapi.test.ts
git commit -m "feat(openapi): a document derived from the registry, not written beside it"
```

---

### Task 4: `/docs`, and the committed spec

**Files:**
- Create: `apps/api/src/routes/docs.routes.ts`, `apps/api/scripts/openapi.ts`, `docs/openapi.json`
- Modify: `apps/api/src/routes/index.ts`, `apps/api/package.json`
- Test: `apps/api/tests/http/openapi.test.ts` (append)

**Interfaces:**
- Consumes: `buildOpenApiDocument`.
- Produces: `GET /docs` (HTML), `GET /docs/openapi.json` (the document), both `access: { kind: 'public' }`; `pnpm --filter @ledger/api openapi` writing `docs/openapi.json`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/http/openapi.test.ts`:

```ts
describe('GET /docs', () => {
  it('serves the document without a credential', async () => {
    const response = await request(app).get('/docs/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
  });

  it('serves a page without a credential', async () => {
    const response = await request(app).get('/docs');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
  });

  it('matches the committed spec', async () => {
    const committed = JSON.parse(await readFile(SPEC_PATH, 'utf8'));

    expect(buildOpenApiDocument(definitions)).toEqual(committed);
  });
});
```

The third is the drift check. Its failure message should tell the reader to run the generator — add that as the assertion's message.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api test tests/http/openapi.test.ts
```

Expected: FAIL — 404 on both routes, and no committed spec.

- [ ] **Step 3: Write the routes**

`docs.routes.ts` exports the two definitions. The HTML is a single template string loading Scalar from a CDN and pointing it at `/docs/openapi.json`, with a comment noting the one cost of that choice: the page needs network access to render, while the JSON does not.

Register them in `routes/index.ts` with the others.

- [ ] **Step 4: Write the generator script and run it**

`scripts/openapi.ts` builds the document from the same definitions the app uses and writes `docs/openapi.json`, formatted with two-space indentation and a trailing newline, so the committed file diffs cleanly.

```json
    "openapi": "node --import tsx scripts/openapi.ts",
```

```bash
pnpm --filter @ledger/api openapi
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @ledger/api test tests/http/openapi.test.ts
```

Expected: PASS, including the drift check.

- [ ] **Step 6: Prove the drift check works**

Add a route to the registry with a fake handler, run the test without regenerating.

Expected: FAIL, naming the difference. Remove the route.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/docs.routes.ts apps/api/src/routes/index.ts apps/api/scripts/openapi.ts apps/api/package.json docs/openapi.json apps/api/tests/http/openapi.test.ts
git commit -m "feat(docs): serve the spec at /docs, and fail when the committed one drifts"
```

---

### Task 5: The ADRs

**Files:**
- Create: `docs/adr/0001-invariants-in-the-database.md`, `docs/adr/0002-money-as-minor-units.md`, `docs/adr/0003-idempotency-in-postgres.md`, `docs/adr/0005-balance-checkpoints.md`

**Interfaces:** none — prose.

- [ ] **Step 1: Find the dates**

```bash
git log --reverse --format='%h %ad %s' --date=short -- apps/api/drizzle/0003_invariants.sql packages/shared/src/money.ts apps/api/src/middleware/idempotency.ts
```

Each ADR's `Date:` is the date its decision was made, from this output. Each carries one line under the heading saying the record was written in stage 7, after the fact. Do not present a backfilled record as contemporaneous.

- [ ] **Step 2: Write 0001 — invariants in the database**

Context: an application can be bypassed by a psql session, a migration, a second service, or a bug. Decision: invariant 1 (entries balance) in a deferred constraint trigger, invariant 2 (append-only) in both a REVOKE and a trigger that binds the owner, the overdraft rule in a constraint trigger, isolation in row-level security. Consequences: errors arrive as SQLSTATEs that need translating (`db/pg-errors.ts`); tests need a real Postgres, so the suite needs Docker and is slower than a unit suite; the rules cannot be turned off by a deploy. Cite `0003_invariants.sql` for why a CHECK cannot express invariant 1.

- [ ] **Step 3: Write 0002 — money as minor units**

Context: floats cannot represent money; JS `number` loses integers past 2^53. Decision: `bigint` minor units end to end, decimal strings on the wire, one parse/format boundary in `money.ts`. Consequences: `::text` casts on every SQL sum; JSON has no bigint, so serialisation is explicit; posting ids are strings for the same reason. Name what it costs: every aggregate has a cast, and forgetting one is a class of bug that only shows up above 2^53.

- [ ] **Step 4: Write 0003 — idempotency in Postgres, not Redis (the boring one)**

Say plainly that this is the boring option and that it won. Context: `POST /books/:id/entries` must be safely retryable. Redis is the reflexive answer — fast, TTL built in, one `SETNX`. Decision: a table keyed `(book_id, key)`, reserved in the same transaction as the write it guards. Consequences: the reservation and the entry commit or roll back together, with no window where one exists without the other, and no second datastore to run, secure, back up or reason about during a partition. The cost, stated honestly: rows are never pruned (a TTL is exactly what Redis would have given for free), the reservation contends on the same database under load, and this is the write path's extra round trip. Reference the state-dependent-4xx rule: only deterministic outcomes are replayed from the cache.

- [ ] **Step 5: Write 0005 — balance checkpoints keyed on posting id**

Context: 500,000 postings, and the plans in `docs/performance.md` — quote the baseline number for the sum from zero. Decision: `balance_checkpoints(account_id, through_id, ...)`, append-only, refreshed by an explicit call, read by two id-shaped paths. The argument for id over date, in full, as in the schema comment. Consequences: `asOf`, the trial balance and the overdraft scan get nothing from it; nothing schedules the refresh; a stale checkpoint costs time and never correctness; the sum-from-zero path stays, and the agreement property is what makes keeping it worthwhile.

- [ ] **Step 6: Check the cross-references**

Every ADR that names a file must name one that exists at the path given. Every claim with a number must match `docs/performance.md`.

- [ ] **Step 7: Commit**

```bash
git add docs/adr
git commit -m "docs(adr): the four decisions the record was missing, dated when they were made"
```

---

### Task 6: `docs/limitations.md`

**Files:**
- Create: `docs/limitations.md`

- [ ] **Step 1: Write it**

One section per limitation: what is missing, what it costs today, and what fixing it would take. No hedging, no "in a future version". Cover at least:

- Checkpoint refresh is manual. Nothing schedules it. A stale checkpoint is slower, never wrong.
- `asOf` balances, the trial balance and the overdraft prefix scan cannot use a checkpoint. The last one is the one that runs under a lock — quote the indexed number from `docs/performance.md`.
- `apps/web` is a stub. Stage 6 shipped the shared contract and the reads a frontend would need; there are no screens.
- Responses are typed and specified but not parsed at runtime. Tests are the only thing that catches a handler drifting from the spec.
- Idempotency rows are never pruned.
- No rate limiting, no metrics, no tracing.
- No down migrations. Rolling back means restoring a database.
- One currency per account; no FX, no revaluation.
- Refresh tokens rotate, but there is no session list and no way to revoke one device.
- CI verifies and does not deploy.

Anything discovered while writing plans 1 and 2 that did not get fixed goes here too. A limitations file that only lists what was already known is a limitations file nobody wrote honestly.

- [ ] **Step 2: Commit**

```bash
git add docs/limitations.md
git commit -m "docs(limitations): what is missing, and what fixing it would take"
```

---

### Task 7: The README, and where the deep prose goes

**Files:**
- Create: `docs/testing.md`, `docs/database.md`
- Modify: `README.md`

- [ ] **Step 1: Move the internals out**

`docs/testing.md` takes the README's current *Property-based tests*, *What it found*, *The corpus* and *Query counting* sections, plus a short new section on the checkpoint agreement property from plan 1. `docs/database.md` takes *Two connections, two roles* and the invariant detail. Move the prose as it stands; edit only what stops making sense out of context.

- [ ] **Step 2: Rewrite the opening**

It currently says stages 1 and 2 are complete and there is no HTTP layer. Replace with what the system is: a double-entry ledger with an HTTP API, cookie auth and API keys, role-based authorization, row-level security, idempotent writes, reversals, an overdraft rule enforced over every prefix of an account's history, and balance checkpoints. Keep the invariants list — it is the best thing in the file.

- [ ] **Step 3: Write Decisions & Tradeoffs**

One entry per ADR, each stating the decision, the alternative rejected, what it costs, and a link. Add two that have no ADR but shape the codebase: the route registry as the single place a route can exist, and derived-not-stored balances. Keep each to a short paragraph — the ADR is where the argument lives.

- [ ] **Step 4: Add the pointers**

Links to `docs/performance.md`, `docs/limitations.md`, `docs/testing.md`, `docs/database.md`, `docs/adr/`, and `/docs` for the API spec. A short *Running it* section keeps the commands it already has, plus `perf:seed`, `perf:explain`, `checkpoint` and `openapi`.

- [ ] **Step 5: Check every link**

```bash
grep -oE '\]\([^)h][^)]*\)' README.md docs/*.md
```

Open each target and confirm it exists. A README whose links 404 is worse than one without them.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/testing.md docs/database.md
git commit -m "docs(readme): a true opening, the decisions, and the internals moved out"
```

---

### Task 8: CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: ci

on:
  push:
  workflow_dispatch:

# One run per ref. A push that supersedes another cancels it rather than queueing behind it.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # Split from `test` because these two fail in under a minute and should not wait behind a
  # suite that starts containers.
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint

  test:
    runs-on: ubuntu-latest
    env:
      # The integration suites start their own Postgres through Testcontainers, against the
      # runner's Docker daemon. These two are for the seed smoke check below, which uses the
      # compose database like a developer would.
      DATABASE_URL: postgres://ledger_app:ledger_app_dev@localhost:5433/ledger
      DATABASE_MIGRATION_URL: postgres://ledger_owner:ledger_owner_dev@localhost:5433/ledger
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - run: pnpm db:up
      - run: pnpm db:migrate
      # Small on purpose. This proves the script still runs against the current schema; the
      # 500k numbers in docs/performance.md are taken by hand, because a timing threshold on a
      # shared runner measures the runner.
      - run: pnpm --filter @ledger/api perf:seed --postings 2000
```

Copy the two connection strings from `.env.example` rather than retyping them, and confirm the compose port matches.

Pin the action versions to whatever is current when you write this; do not copy a version from this plan without checking it exists.

- [ ] **Step 2: Check the config the app needs**

`pnpm test` may require more environment variables than the two above — read `src/config.ts` and `.env.example` and add exactly the ones the test path reads. Do not add a variable "just in case"; an unused secret in a workflow is a thing someone later has to explain.

- [ ] **Step 3: Push and watch it run**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck, lint and test on every push"
```

```bash
git push
```

Then check the run:

```bash
gh run watch
```

Expected: both jobs green. If `test` fails on Docker, the runner's daemon is available but Testcontainers may need `TESTCONTAINERS_RYUK_DISABLED=true` — add it with a comment saying why, not silently.

- [ ] **Step 4: Prove it can fail**

Push a branch with a deliberate type error and confirm `static` goes red, then remove it. A pipeline nobody has seen fail is a pipeline nobody has tested.

---

## Done when

- `GET /docs` renders and `GET /docs/openapi.json` returns a 3.1 document, both without a credential.
- The committed `docs/openapi.json` matches what the generator produces, and the test says so — verified by making it fail once.
- Every non-public route declares the schemas its handler parses, enforced by `routes.meta.test.ts`.
- Real responses parse against the published response schemas.
- Five ADRs exist, dated when their decisions were made, one of them explicitly the boring option.
- `docs/limitations.md` names the frontend gap, the manual checkpoint refresh, and what the checkpoint cannot accelerate.
- The README's opening is true, its Decisions & Tradeoffs section links every ADR, and every link resolves.
- The workflow is green on a push, and has been seen to fail on a broken one.
