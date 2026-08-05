# Stage 6, plan 1 — the shared contract and the three reads

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every request shape and response type into `packages/shared`, then add the three read endpoints the frontend needs, so that no screen in plans 2 and 3 is blocked on the API.

**Architecture:** `packages/shared` becomes the contract package both sides import — Zod schemas for requests, TypeScript types for responses. `apps/api` deletes its local copies and imports them, which is a refactor with no behaviour change; the existing suites staying green is the proof. Then three `GET` routes are added through the existing registry, each with a `book:read` permission, plus two fields on existing resources (`BookResource.role`, `EntryResource.reversedBy`) that let the client stop offering operations that cannot succeed.

**Tech Stack:** TypeScript 5.9.3, Zod 4.4.3, drizzle-orm 0.45.2, Express 5, Vitest 4, supertest, Testcontainers Postgres 16.

This is plan 1 of 3 for stage 6. Plan 2 is the web scaffold and shell; plan 3 is the five screens and the end-to-end path. Nothing here touches `apps/web`.

Spec: `docs/superpowers/specs/2026-08-05-stage-6-frontend-design.md`.

## Global Constraints

- Node >= 22, pnpm 11.8.0. Never `npm` or `yarn`.
- Dependency versions are pinned exactly in this repo — no `^`, no `~`. Zod is `4.4.3`, matching `apps/api`.
- ESM throughout. Relative imports carry the `.js` extension even in TypeScript source (`./requests.js`), because that is what the compiled specifier is.
- `process.env` may be read only in `apps/api/src/config.ts`. `pnpm lint` fails otherwise.
- Amounts are `bigint` minor units internally and decimal strings at the boundary. Never a JS `number`, never a JSON number.
- Every route needs a row in `apps/api/src/routes/registry.ts` with an `access`. `tests/http/routes.meta.test.ts` fails the build if Express has a route the table does not.
- Before every commit: `pnpm lint`, `pnpm typecheck`, and the tests named in that task's steps must pass.
- Commit messages are conventional and lowercase, in the style already in `git log` (`feat(ledger): ...`, `refactor(shared): ...`). No attribution footer, no co-author trailer.
- Integration tests need a running Docker daemon. They start their own Postgres via Testcontainers; `pnpm db:up` is not required for them.

## File Structure

**`packages/shared/src/contracts/requests.ts`** (new) — every Zod schema describing a request body or query, and the `z.input` type for each. Owns the currency regex. No imports from `apps/api`.

**`packages/shared/src/contracts/responses.ts`** (new) — the TypeScript shape of every JSON resource the API returns. Types only, no runtime code.

**`packages/shared/src/contracts/roles.ts`** (new) — `BOOK_ROLES` and `BookRole`, moved out of `apps/api/src/domain/policy.ts` because a response type needs to name a role. The `POLICY` map does not move: what a role *may do* stays the API's business.

**`apps/api/src/domain/policy.ts`** (modified) — imports the roles from shared and re-exports them, so no other API file changes.

**`apps/api/src/services/*.ts`** (modified) — delete local schemas, import from shared.

**`apps/api/src/http/serialize.ts`** (modified) — keeps the functions, imports the types, gains `reversedBy`.

**`apps/api/src/repositories/membership.repository.ts`** (modified) — `listBooksForUser`, `findBookById`.

**`apps/api/src/repositories/ledger.repository.ts`** (modified) — `listAccountsByBook`.

**`apps/api/src/services/book.service.ts`** (modified) — `listBooks`.

**`apps/api/src/services/ledger.service.ts`** (modified) — `listAccounts`, `getEntry`.

**`apps/api/src/routes/books.routes.ts`**, **`ledger.routes.ts`** (modified) — three handlers, three registry rows.

---

### Task 1: Request schemas move to `packages/shared`

**Files:**
- Create: `packages/shared/src/contracts/requests.ts`
- Create: `packages/shared/src/contracts/requests.test.ts`
- Modify: `packages/shared/package.json` (add `zod`)
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/src/services/auth.service.ts`, `book.service.ts`, `ledger.service.ts`
- Modify: `apps/api/src/http/validate.ts`

**Interfaces:**
- Produces: `credentials`, `createBookInput`, `createAccountInput`, `postEntryInput`, `reverseEntryInput`, `paginationQuery`, `listPostingsInput` as Zod schemas; `CredentialsInput`, `CreateBookInput`, `CreateAccountInput`, `PostEntryInput`, `ReverseEntryInput`, `ListPostingsOptions` as `z.input` types. All exported from `@ledger/shared`.
- Consumes: nothing.

- [ ] **Step 1: Add zod to the shared package**

In `packages/shared/package.json`, add to `dependencies` (alongside `uuidv7`):

```json
"zod": "4.4.3"
```

Then run:

```bash
pnpm install
```

- [ ] **Step 2: Write the failing test**

Create `packages/shared/src/contracts/requests.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  createAccountInput,
  listPostingsInput,
  postEntryInput,
  reverseEntryInput,
} from './requests.js';

const ACCOUNT = '3f4d0b7e-9a5e-4c3b-8a52-2c1f5c9a1b23';
const OTHER = '9b1c2d3e-4f50-4a6b-9c8d-7e6f5a4b3c2d';

function leg(overrides: Record<string, unknown> = {}) {
  return { accountId: ACCOUNT, amount: '10.00', currency: 'EUR', ...overrides };
}

describe('postEntryInput', () => {
  it('accepts a two-legged entry and leaves the amounts as strings', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      legs: [leg(), leg({ accountId: OTHER, amount: '-10.00' })],
    });

    expect(result.success).toBe(true);
    expect(result.data?.legs[0]?.amount).toBe('10.00');
  });

  it('coerces occurredAt to a Date, because the caller asserts it as a string', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      legs: [leg(), leg({ accountId: OTHER, amount: '-10.00' })],
    });

    expect(result.data?.occurredAt).toBeInstanceOf(Date);
  });

  it('rejects a single-legged entry with the message the API answers with', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      legs: [leg()],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('an entry needs at least two legs');
  });

  it('rejects a currency that is not three uppercase letters', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      legs: [leg({ currency: 'eur' }), leg({ accountId: OTHER, amount: '-10.00' })],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a blank description', () => {
    const result = postEntryInput.safeParse({
      occurredAt: '2026-03-01T12:00:00.000Z',
      description: '   ',
      legs: [leg(), leg({ accountId: OTHER, amount: '-10.00' })],
    });

    expect(result.success).toBe(false);
  });
});

describe('createAccountInput', () => {
  it('accepts the five account types and nothing else', () => {
    for (const type of ['asset', 'liability', 'equity', 'revenue', 'expense']) {
      expect(createAccountInput.safeParse({ name: 'Cash', type, currency: 'EUR' }).success).toBe(true);
    }

    expect(createAccountInput.safeParse({ name: 'Cash', type: 'goodwill', currency: 'EUR' }).success).toBe(
      false,
    );
  });
});

describe('reverseEntryInput', () => {
  it('accepts an empty object, because a reversal determines its own legs', () => {
    expect(reverseEntryInput.safeParse({}).success).toBe(true);
  });
});

describe('listPostingsInput', () => {
  it('defaults the page size to 50 and coerces a query string', () => {
    expect(listPostingsInput.parse({})).toEqual({ limit: 50 });
    expect(listPostingsInput.parse({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('refuses a page size above the cap', () => {
    expect(listPostingsInput.safeParse({ limit: 201 }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @ledger/shared test
```

Expected: FAIL — `Cannot find module './requests.js'`.

- [ ] **Step 4: Create the contract module**

Create `packages/shared/src/contracts/requests.ts`. The schema bodies are moved verbatim from `apps/api/src/services/*.ts`; only the names lose their `Schema` suffix.

```ts
import { z } from 'zod';

/**
 * Every request shape, in one place, imported by the service that enforces it and by the
 * client that has to satisfy it.
 *
 * These lived in the services until stage 6, because nothing outside them had an opinion.
 * The frontend does: the composer greys out submit on exactly the rule `postEntryInput`
 * states, and a second copy of that rule would eventually disagree with this one - silently,
 * and in the direction of offering the user a button that cannot work.
 *
 * What is here is shape only. Whether the account is open, whether the currencies match,
 * whether the entry overdraws anything are questions about the database, and they stay in
 * the service. That is the same 400-versus-422 split `http/validate.ts` describes.
 */

const CURRENCY_RE = /^[A-Z]{3}$/;

const currency = z
  .string()
  .regex(CURRENCY_RE, 'must be a three-letter ISO 4217 code, such as EUR');

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'must be an email address');

/**
 * The upper bound is not a strength consideration - it is there because the password is fed
 * to a deliberately expensive hash, and an unbounded one lets a caller choose how much CPU
 * this process spends on their request.
 */
const passwordSchema = z.string().min(12, 'must be at least 12 characters').max(1024);

export const credentials = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export type CredentialsInput = z.input<typeof credentials>;

export const createBookInput = z.object({
  name: z.string().trim().min(1, 'must not be blank').max(200),
  baseCurrency: currency,
});

export type CreateBookInput = z.input<typeof createBookInput>;

/**
 * The five account types of double-entry bookkeeping, matching the Postgres enum. Fixed by
 * accounting rather than by product requirements - there will never be a sixth.
 */
export const createAccountInput = z.object({
  name: z.string().trim().min(1, 'must not be blank').max(200),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  currency,
  parentId: z.uuid('must be a UUID').nullish(),
});

export type CreateAccountInput = z.input<typeof createAccountInput>;

/**
 * Amounts cross this boundary as decimal strings - `"12.34"`, not `1234` and not `12.34` as
 * a JSON number - and are minor-unit bigints from here inward. Strings because JSON numbers
 * are IEEE 754 doubles, and a ledger that can hold a value it cannot round-trip through its
 * own API is not one you would put money in. Decimal rather than minor units because the
 * caller then does not have to know that JPY has no minor unit and KWD has three; that table
 * lives in `money.ts`, next door, and both sides import it.
 */
const legInput = z.object({
  accountId: z.uuid('must be a UUID'),
  amount: z.string(),
  currency,
});

export const postEntryInput = z.object({
  /** When it happened in the world. Asserted by the caller; never read from the clock. */
  occurredAt: z.coerce.date(),
  description: z.string().trim().min(1, 'must not be blank').max(1000),
  /**
   * Caller-supplied idempotency key. Unique per book, and the reason posting the same entry
   * twice is safe.
   */
  externalId: z.string().trim().min(1, 'must not be blank').max(255).nullish(),
  /**
   * Two legs minimum. A single-leg entry cannot sum to zero unless the leg is zero, and a
   * zero leg is rejected as well - so the alternative to this bound is a worse error message
   * later, never an accepted entry.
   */
  legs: z.array(legInput).min(2, 'an entry needs at least two legs').max(1000),
});

export type PostEntryInput = z.input<typeof postEntryInput>;

/**
 * Everything about a reversal is optional. The legs are determined by the original - that is
 * what makes it a reversal rather than a new entry that happens to look like one.
 */
export const reverseEntryInput = z.object({
  occurredAt: z.coerce.date().optional(),
  description: z.string().trim().min(1, 'must not be blank').max(1000).optional(),
  externalId: z.string().trim().min(1, 'must not be blank').max(255).nullish(),
});

export type ReverseEntryInput = z.input<typeof reverseEntryInput>;

/**
 * Two pagination schemas, deliberately, because they answer different questions.
 *
 * `paginationQuery` is the HTTP boundary: is this query string shaped like pagination. It
 * has no default, because "the caller did not say" and "the caller said 50" are different
 * facts and only the service gets to turn the first into the second.
 */
export const paginationQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** The service's own input, where the default lives. */
export const listPostingsInput = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ListPostingsOptions = z.input<typeof listPostingsInput>;
```

- [ ] **Step 5: Export it from the package entry point**

Append to `packages/shared/src/index.ts`:

```ts
export {
  credentials,
  createBookInput,
  createAccountInput,
  postEntryInput,
  reverseEntryInput,
  paginationQuery,
  listPostingsInput,
  type CredentialsInput,
  type CreateBookInput,
  type CreateAccountInput,
  type PostEntryInput,
  type ReverseEntryInput,
  type ListPostingsOptions,
} from './contracts/requests.js';
```

- [ ] **Step 6: Run the test and watch it pass**

```bash
pnpm --filter @ledger/shared test
```

Expected: PASS, 9 tests.

- [ ] **Step 7: Rewire the API services to import them**

In `apps/api/src/services/auth.service.ts`: delete `emailSchema`, `passwordSchema`, `credentialsSchema` and the local `export type CredentialsInput`. Import instead:

```ts
import { credentials as credentialsSchema, type CredentialsInput } from '@ledger/shared';
```

Re-export the type so existing importers are unaffected:

```ts
export type { CredentialsInput };
```

In `apps/api/src/services/book.service.ts`: delete `createBookSchema` and its `export type CreateBookInput`. Keep `grantRoleSchema` and `issueApiKeySchema` where they are — no screen in stage 6 uses them, and moving them would drag `BOOK_ROLES` along for no consumer. Import:

```ts
import { createBookInput as createBookSchema, type CreateBookInput } from '@ledger/shared';
export type { CreateBookInput };
```

In `apps/api/src/services/ledger.service.ts`: delete `CURRENCY_RE`, `legInputSchema`, `postEntryInputSchema`, `listPostingsOptionsSchema`, `createAccountSchema`, `reverseEntryInputSchema`, and the four local `export type` lines. Delete the paragraph of the file-header comment that begins "These schemas move to `packages/shared` in stage 3" — it has now happened, and it named the wrong stage. Import:

```ts
import {
  createAccountInput as createAccountSchema,
  listPostingsInput as listPostingsOptionsSchema,
  postEntryInput as postEntryInputSchema,
  reverseEntryInput as reverseEntryInputSchema,
  type CreateAccountInput,
  type ListPostingsOptions,
  type PostEntryInput,
  type ReverseEntryInput,
} from '@ledger/shared';

export type { CreateAccountInput, ListPostingsOptions, PostEntryInput, ReverseEntryInput };
```

`CURRENCY_RE` goes with them: its only two uses in that file are inside `legInputSchema` and `createAccountSchema`, both of which are being deleted.

In `apps/api/src/http/validate.ts`: delete the local `paginationQuery` and re-export the shared one, so `ledger.routes.ts` needs no edit:

```ts
export { paginationQuery } from '@ledger/shared';
```

- [ ] **Step 8: Run the whole API suite**

```bash
pnpm --filter @ledger/api test
```

Expected: PASS, everything. This task changes no behaviour, so any failure is a mistake in the move — most likely a message string that drifted. Fix it against the original rather than editing the test.

- [ ] **Step 9: Typecheck and lint**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

- [ ] **Step 10: Commit**

```bash
git add packages/shared apps/api/src/services apps/api/src/http/validate.ts pnpm-lock.yaml
git commit -m "refactor(shared): the request schemas move to the package both sides import"
```

---

### Task 2: Response types move to `packages/shared`

**Files:**
- Create: `packages/shared/src/contracts/roles.ts`
- Create: `packages/shared/src/contracts/responses.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/src/domain/policy.ts`
- Modify: `apps/api/src/http/serialize.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `BOOK_ROLES`, `BookRole`, and the types `BookResource`, `AccountResource`, `EntryResource`, `BalanceResource`, `TrialBalanceResource`, `PostingPageResource`, all exported from `@ledger/shared`. `BookResource` has `{ id, name, baseCurrency, createdAt, role }`; `AccountResource` has `{ id, bookId, name, type, currency, parentId, closedAt }`. Tasks 3, 4 and 5 return exactly these.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/contracts/roles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BOOK_ROLES } from './roles.js';

describe('BOOK_ROLES', () => {
  it('is the three roles the database enum holds, in privilege order', () => {
    expect(BOOK_ROLES).toEqual(['owner', 'accountant', 'viewer']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/shared test
```

Expected: FAIL — `Cannot find module './roles.js'`.

- [ ] **Step 3: Create the roles module**

Create `packages/shared/src/contracts/roles.ts`:

```ts
/**
 * The three per-book roles, matching the `book_role` Postgres enum.
 *
 * Here rather than in the API because a response type names a role: `GET /books` tells the
 * caller what they may do in each book, so the client can decline to offer what the policy
 * forbids. What a role *may do* is not here - `apps/api/src/domain/policy.ts` remains the
 * only authority on that, and moving it would put an authorization decision in a package the
 * browser downloads.
 */
export const BOOK_ROLES = ['owner', 'accountant', 'viewer'] as const;

export type BookRole = (typeof BOOK_ROLES)[number];
```

- [ ] **Step 4: Create the response types**

Create `packages/shared/src/contracts/responses.ts`. The last four are moved verbatim from `apps/api/src/http/serialize.ts`.

```ts
import type { BookRole } from './roles.js';

/**
 * The shape of every JSON resource this API returns.
 *
 * Types, not schemas. A runtime parse at the client boundary would catch a server-side shape
 * change as an error instead of as `undefined` in a cell, and it would cost a schema per
 * resource and a parse per response against a server in this same repository, typechecked by
 * this same command. The field most likely to be wrong is validated either way: every amount
 * goes through `parseMoney`, which throws on anything that is not a decimal string.
 *
 * Three conventions hold throughout, and `serialize.ts` explains why: amounts are decimal
 * strings, posting ids are strings because a bigserial outruns `Number.MAX_SAFE_INTEGER`,
 * and timestamps are ISO 8601 with an offset.
 */

export interface BookResource {
  readonly id: string;
  readonly name: string;
  readonly baseCurrency: string;
  readonly createdAt: string;
  /**
   * The caller's role in this book. Present so the UI can stop offering what the policy
   * forbids - a viewer should not be shown a compose button that always ends in a 403. The
   * server still decides; this only lets the client stop asking.
   */
  readonly role: BookRole;
}

export interface AccountResource {
  readonly id: string;
  readonly bookId: string;
  readonly name: string;
  readonly type: string;
  readonly currency: string;
  /** Null for a root account. The tree the frontend draws is built from this column. */
  readonly parentId: string | null;
  readonly closedAt: string | null;
}

export interface EntryResource {
  readonly id: string;
  readonly bookId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly description: string;
  readonly externalId: string | null;
  readonly reversalOf: string | null;
  /**
   * The reversal of this entry, where one exists. The inverse of `reversalOf`, and the only
   * way a caller can know an entry is already reversed without attempting the reversal and
   * reading `ENTRY_ALREADY_REVERSED` off the failure.
   */
  readonly reversedBy: string | null;
  readonly postings: readonly {
    readonly id: string;
    readonly accountId: string;
    readonly amount: string;
    readonly currency: string;
  }[];
}

export interface BalanceResource {
  readonly accountId: string;
  readonly asOf: string | null;
  readonly balance: string;
  readonly currency: string;
}

export interface TrialBalanceResource {
  readonly bookId: string;
  readonly asOf: string | null;
  readonly accounts: readonly {
    readonly accountId: string;
    readonly name: string;
    readonly type: string;
    readonly currency: string;
    readonly balance: string;
  }[];
  readonly totals: readonly {
    readonly currency: string;
    readonly debits: string;
    readonly credits: string;
    readonly balanced: boolean;
  }[];
  readonly balanced: boolean;
}

export interface PostingPageResource {
  readonly accountId: string;
  readonly items: readonly {
    readonly id: string;
    readonly entryId: string;
    readonly occurredAt: string;
    readonly recordedAt: string;
    readonly description: string;
    readonly amount: string;
    readonly runningBalance: string;
    readonly currency: string;
  }[];
  readonly nextCursor: string | null;
}
```

- [ ] **Step 5: Export both from the entry point**

Append to `packages/shared/src/index.ts`:

```ts
export { BOOK_ROLES, type BookRole } from './contracts/roles.js';
export type {
  BookResource,
  AccountResource,
  EntryResource,
  BalanceResource,
  TrialBalanceResource,
  PostingPageResource,
} from './contracts/responses.js';
```

- [ ] **Step 6: Run the shared suite**

```bash
pnpm --filter @ledger/shared test
```

Expected: PASS.

- [ ] **Step 7: Point the API at the shared roles**

In `apps/api/src/domain/policy.ts`, delete the local `BOOK_ROLES` declaration and its `BookRole` type, and replace them with a re-export so every existing importer is untouched:

```ts
import { BOOK_ROLES, type BookRole } from '@ledger/shared';

export { BOOK_ROLES, type BookRole };
```

`POLICY`, `PERMISSIONS`, `isPermission`, `isBookRole`, `can` and `permissionsOf` stay exactly as they are.

- [ ] **Step 8: Point the serializer at the shared types**

In `apps/api/src/http/serialize.ts`, delete the four local `export interface` declarations and import the types instead, re-exporting them so the route modules do not change:

```ts
import type {
  BalanceResource,
  EntryResource,
  PostingPageResource,
  TrialBalanceResource,
} from '@ledger/shared';

export type { BalanceResource, EntryResource, PostingPageResource, TrialBalanceResource };
```

`serializeEntry` now fails to typecheck, because `EntryResource` requires `reversedBy` and nothing supplies it. That is Task 5's job. For this task only, make the requirement explicit rather than papering over it: leave the error in place and finish the task in Step 9 by having `serializeEntry` accept it as an argument.

Change the signature and the returned object:

```ts
export function serializeEntry(entry: EntryRecord, reversedBy: string | null = null): EntryResource {
  return {
    id: entry.id,
    bookId: entry.bookId,
    occurredAt: entry.occurredAt.toISOString(),
    recordedAt: entry.recordedAt.toISOString(),
    description: entry.description,
    externalId: entry.externalId,
    reversalOf: entry.reversalOf,
    reversedBy,
    postings: entry.postings.map((posting) => ({
      id: posting.id.toString(),
      accountId: posting.accountId,

      // The raw minor-unit amount is deliberately not exposed alongside this. Two
      // representations of one number is two things a client can disagree about, and the
      // decimal string is the one the API boundary is defined in.
      amount: formatMoney({ amountMinor: posting.amountMinor, currency: posting.currency }),
      currency: posting.currency,
    })),
  };
}
```

The default is `null` so `POST /books/:bookId/entries` and `POST /entries/:entryId/reverse` keep compiling and keep answering correctly: an entry that was just created has not been reversed, and a reversal is not itself reversed. Task 5 passes a real value from the one route that can know.

- [ ] **Step 9: Run the API suite**

```bash
pnpm --filter @ledger/api test
```

Expected: PASS. Two existing files assert on entry bodies — `tests/http/ledger.test.ts` and `tests/http/reversal.test.ts` — and both use `toMatchObject`, so an added field does not break them. If either uses `toEqual` on a whole entry body, add `reversedBy: null` to the expectation.

- [ ] **Step 10: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add packages/shared apps/api/src/domain/policy.ts apps/api/src/http/serialize.ts apps/api/tests
git commit -m "refactor(shared): the response contracts, and the roles a response has to name"
```

---

### Task 3: `GET /books`

**Files:**
- Modify: `apps/api/src/repositories/membership.repository.ts`
- Modify: `apps/api/src/services/book.service.ts`
- Modify: `apps/api/src/routes/books.routes.ts`
- Test: `apps/api/tests/http/books.test.ts` (new — there is no books test file today)

**Interfaces:**
- Consumes: `BookResource`, `BookRole` from Task 2.
- Produces: `MembershipRepository.listBooksForUser(executor, userId): Promise<BookMembershipRecord[]>` and `findBookById(executor, bookId): Promise<BookSummary | null>`; `BookService.listBooks(principal: Principal): Promise<BookResource[]>`.

Neither `books` nor `book_members` is behind row-level security — migration `0006` covers `accounts`, `entries` and `postings` only — so this reads in a plain transaction with no book context. It could not do otherwise: answering "which books may this caller see" happens before there is a book to be inside of.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/http/books.test.ts`:

```ts
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApplication, type TestApplication } from '../helpers/app.js';
import { bearer, createBook, registerUser, type TestBook, type TestUser } from '../helpers/books.js';

/**
 * Books over HTTP, and the one question that has to be answerable before any book is known:
 * which books does this caller have.
 */

let application: TestApplication;
let owner: TestUser;
let book: TestBook;

beforeAll(async () => {
  application = createTestApplication();
  owner = await registerUser(application);
  book = await createBook(application, owner);
});

afterAll(async () => {
  await application.close();
});

const api = () => request(application.app);
const auth = () => bearer(owner.accessToken);

describe('GET /books', () => {
  it('lists the caller\'s books with the role they hold in each', async () => {
    const response = await api().get('/books').set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: book.bookId, role: 'owner', baseCurrency: 'EUR' }),
      ]),
    );
  });

  it('does not list a book the caller is not a member of', async () => {
    const stranger = await registerUser(application);
    const response = await api().get('/books').set('Authorization', bearer(stranger.accessToken));

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await api().get('/books');

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api test -- --project integration tests/http/books.test.ts
```

Expected: FAIL with 404 and `ROUTE_NOT_FOUND`, because no such route is registered.

- [ ] **Step 3: Add the repository methods**

In `apps/api/src/repositories/membership.repository.ts`, add `books` to the schema import, add these two record types beside `MembershipRecord`:

```ts
export interface BookSummary {
  readonly id: string;
  readonly name: string;
  readonly baseCurrency: string;
  readonly createdAt: Date;
}

export interface BookMembershipRecord extends BookSummary {
  readonly role: BookRole;
}
```

Add both to the `MembershipRepository` interface:

```ts
  /** The books this user is a member of, with the role held in each, ordered by name. */
  listBooksForUser(executor: Executor, userId: string): Promise<BookMembershipRecord[]>;
  findBookById(executor: Executor, bookId: string): Promise<BookSummary | null>;
```

And implement them on `DrizzleMembershipRepository`:

```ts
  async listBooksForUser(executor: Executor, userId: string): Promise<BookMembershipRecord[]> {
    return executor
      .select({
        id: books.id,
        name: books.name,
        baseCurrency: books.baseCurrency,
        createdAt: books.createdAt,
        role: bookMembers.role,
      })
      .from(bookMembers)
      .innerJoin(books, eq(books.id, bookMembers.bookId))
      .where(eq(bookMembers.userId, userId))
      .orderBy(books.name);
  }

  async findBookById(executor: Executor, bookId: string): Promise<BookSummary | null> {
    const [book] = await executor
      .select({
        id: books.id,
        name: books.name,
        baseCurrency: books.baseCurrency,
        createdAt: books.createdAt,
      })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    return book ?? null;
  }
```

- [ ] **Step 4: Add the service method**

In `apps/api/src/services/book.service.ts`, add to `BookService`:

```ts
  /**
   * Every book this caller can reach, and what they may do in it.
   *
   * A user may belong to many books; an API key is scoped to exactly one, which is why the
   * two principals take different paths to the same answer rather than one query with a
   * branch inside it. Neither table is behind row-level security, so this runs in a plain
   * transaction: there is no book context to be inside of before the caller has been told
   * which books exist.
   */
  async listBooks(principal: Principal): Promise<BookResource[]> {
    return this.unitOfWork.transaction(async (tx) => {
      if (principal.kind === 'user') {
        const rows = await this.membershipRepository.listBooksForUser(tx, principal.userId);
        return rows.map(toBookResource);
      }

      const book = await this.membershipRepository.findBookById(tx, principal.bookId);
      return book === null ? [] : [toBookResource({ ...book, role: principal.role })];
    });
  }
```

And below the class, the serializer for it:

```ts
function toBookResource(record: BookMembershipRecord): BookResource {
  return {
    id: record.id,
    name: record.name,
    baseCurrency: record.baseCurrency,
    createdAt: record.createdAt.toISOString(),
    role: record.role,
  };
}
```

Imports to add at the top of the file:

```ts
import type { BookResource } from '@ledger/shared';
import type { Principal } from '../http/context.js';
import type { BookMembershipRecord } from '../repositories/membership.repository.js';
```

- [ ] **Step 5: Add the route and its registry row**

In `apps/api/src/routes/books.routes.ts`, add the handler beside `createBook`:

```ts
  const listBooks: RequestHandler = async (_request, response) => {
    response.json(await books.listBooks(principalOf(response)));
  };
```

And the row, in the returned array:

```ts
    {
      method: 'get',
      path: '/books',
      access: { kind: 'authenticated' },
      summary: 'List the books this caller can reach',
      handler: listBooks,
    },
```

`authenticated` and not `book:read`: there is no book to check a permission against until this call has answered which books there are. The query itself is the authorization — it returns only rows the caller has a membership in.

- [ ] **Step 6: Run the test and watch it pass**

```bash
pnpm --filter @ledger/api test -- --project integration tests/http/books.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Run the route meta-test**

```bash
pnpm --filter @ledger/api test -- --project integration tests/http/routes.meta.test.ts
```

Expected: PASS. It compares the registry against what Express actually has registered; a new route missing its row fails here.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/api
git commit -m "feat(books): list the books a caller can reach, and their role in each"
```

---

### Task 4: `GET /books/:bookId/accounts`

**Files:**
- Modify: `apps/api/src/repositories/ledger.repository.ts`
- Modify: `apps/api/src/services/ledger.service.ts`
- Modify: `apps/api/src/routes/ledger.routes.ts`
- Test: `apps/api/tests/http/ledger.test.ts`

**Interfaces:**
- Consumes: `AccountResource` from Task 2.
- Produces: `LedgerRepository.listAccountsByBook(executor, bookId): Promise<AccountRecord[]>`; `LedgerService.listAccounts(bookId): Promise<AccountRecord[]>`; `serializeAccount(account): AccountResource` in `http/serialize.ts`.

`AccountRecord` as currently declared has no `parentId`. Adding it there is part of this task — the column exists, the record simply never selected it.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/http/ledger.test.ts`:

```ts
describe('GET /books/:bookId/accounts', () => {
  it('lists the book\'s accounts with their parent and closed state', async () => {
    const response = await api()
      .get(`/books/${book.bookId}/accounts`)
      .set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: cash,
          name: 'Cash',
          type: 'asset',
          currency: 'EUR',
          parentId: null,
          closedAt: null,
        }),
      ]),
    );
  });

  it('reports a child account\'s parent', async () => {
    const child = await createAccount(application, book, {
      name: 'Petty cash',
      type: 'asset',
      parentId: cash,
    });

    const response = await api()
      .get(`/books/${book.bookId}/accounts`)
      .set('Authorization', auth());

    const found = response.body.find((account: { id: string }) => account.id === child);
    expect(found.parentId).toBe(cash);
  });

  it('refuses a caller with no membership in the book', async () => {
    const stranger = await registerUser(application);
    const response = await api()
      .get(`/books/${book.bookId}/accounts`)
      .set('Authorization', bearer(stranger.accessToken));

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });
});
```

`createAccount` in `apps/api/tests/helpers/books.ts` does not forward a parent today. Widen it rather than adding a second helper — its `overrides` parameter becomes:

```ts
  overrides: { name?: string; type?: string; currency?: string; parentId?: string } = {},
```

and the body it sends gains one line:

```ts
      ...(overrides.parentId === undefined ? {} : { parentId: overrides.parentId }),
```

Spread conditionally rather than sending `parentId: undefined`, which supertest serialises away but which reads as though a null parent were being asserted.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api test -- --project integration tests/http/ledger.test.ts
```

Expected: FAIL with 404 `ROUTE_NOT_FOUND`.

- [ ] **Step 3: Add `parentId` to `AccountRecord` and the repository method**

In `apps/api/src/repositories/ledger.repository.ts`, add `readonly parentId: string | null;` to the `AccountRecord` interface, and add `parentId: accounts.parentId` to the column list inside `findAccountsByIds` so both read paths agree. Then add to the `LedgerRepository` interface and its Drizzle implementation:

```ts
  /** Every account in a book, ordered the way a tree is read: by type, then by name. */
  listAccountsByBook(executor: Executor, bookId: string): Promise<AccountRecord[]>;
```

```ts
  async listAccountsByBook(executor: Executor, bookId: string): Promise<AccountRecord[]> {
    return executor
      .select({
        id: accounts.id,
        bookId: accounts.bookId,
        name: accounts.name,
        type: accounts.type,
        currency: accounts.currency,
        parentId: accounts.parentId,
        closedAt: accounts.closedAt,
      })
      .from(accounts)
      .where(eq(accounts.bookId, bookId))
      .orderBy(accounts.type, accounts.name);
  }
```

- [ ] **Step 4: Add the service method**

In `apps/api/src/services/ledger.service.ts`, beside `createAccount`:

```ts
  /**
   * Every account in a book, in one query.
   *
   * `transactionInBook` because `accounts` is behind the row-level security policy from
   * migration `0006`, so the book id has to be set on the connection before the policy will
   * return anything at all - the `WHERE` clause below it is belt as well as braces.
   */
  async listAccounts(bookId: string): Promise<AccountRecord[]> {
    return this.unitOfWork.transactionInBook(bookId, (tx) =>
      this.repository.listAccountsByBook(tx, bookId),
    );
  }
```

- [ ] **Step 5: Add the serializer**

In `apps/api/src/http/serialize.ts`, import `AccountResource` alongside the other types and add:

```ts
export function serializeAccount(account: AccountRecord): AccountResource {
  return {
    id: account.id,
    bookId: account.bookId,
    name: account.name,
    type: account.type,
    currency: account.currency,
    parentId: account.parentId,
    closedAt: account.closedAt?.toISOString() ?? null,
  };
}
```

Import `AccountRecord` as a type from `../repositories/ledger.repository.js`.

Then replace the inline object literal in `createAccount` in `apps/api/src/routes/ledger.routes.ts` with a call to `serializeAccount(account)`, so the create and the list answer with the same shape rather than two hand-written ones. The create response gains `parentId`, which it should always have had.

- [ ] **Step 6: Add the route and its registry row**

In `apps/api/src/routes/ledger.routes.ts`:

```ts
  const listAccounts: RequestHandler = async (_request, response) => {
    const { bookId } = bookAccessOf(response);
    const accounts = await ledger.listAccounts(bookId);

    response.json(accounts.map(serializeAccount));
  };
```

```ts
    {
      method: 'get',
      path: '/books/:bookId/accounts',
      access: { kind: 'book', permission: 'book:read', bookFrom: 'param' },
      summary: 'List the accounts of a book',
      handler: listAccounts,
    },
```

- [ ] **Step 7: Run the tests and watch them pass**

```bash
pnpm --filter @ledger/api test -- --project integration tests/http/ledger.test.ts tests/http/routes.meta.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run the whole API suite**

```bash
pnpm --filter @ledger/api test
```

Expected: PASS. `AccountRecord` gained a field and `createAccount`'s response gained `parentId`; anything asserting on that shape with `toEqual` needs the field added to its expectation.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/api
git commit -m "feat(ledger): list a book's accounts, parent included, so a tree can be drawn"
```

---

### Task 5: `GET /entries/:entryId`, and `reversedBy`

**Files:**
- Modify: `apps/api/src/services/ledger.service.ts`
- Modify: `apps/api/src/routes/ledger.routes.ts`
- Test: `apps/api/tests/http/reversal.test.ts`

**Interfaces:**
- Consumes: `EntryResource` and the two-argument `serializeEntry` from Task 2.
- Produces: `LedgerService.getEntry(bookId, entryId): Promise<{ entry: EntryRecord; reversedBy: string | null }>`.

`findEntryById` and `findReversalOf` both already exist on the repository, and `BookSource: 'entry'` already exists in the registry — the guard resolves the book through the `book_of_entry` SECURITY DEFINER function from migration `0006`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/http/reversal.test.ts`, which already has everything this needs: `freshBook()` returning a `Fixture`, `post(fixture, amount, description?)` returning the supertest response for a two-legged entry, and the `api()` / `auth()` shorthands. A fresh book per test is that file's isolation strategy — keep it.

```ts
describe('GET /entries/:entryId', () => {
  it('returns the entry with its legs, and null for reversedBy while it stands', async () => {
    const fixture = await freshBook();
    const posted = await post(fixture, '10.00');

    const response = await api().get(`/entries/${posted.body.id}`).set('Authorization', auth());

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: posted.body.id, reversalOf: null, reversedBy: null });
    expect(response.body.postings).toHaveLength(2);
  });

  it('names the reversal once one exists', async () => {
    const fixture = await freshBook();
    const posted = await post(fixture, '10.00');

    const reversal = await api()
      .post(`/entries/${posted.body.id}/reverse`)
      .set('Authorization', auth())
      .send({});

    const response = await api().get(`/entries/${posted.body.id}`).set('Authorization', auth());

    expect(response.body.reversedBy).toBe(reversal.body.id);
  });

  it('says the reversal itself reverses the original and is not reversed', async () => {
    const fixture = await freshBook();
    const posted = await post(fixture, '10.00');

    const reversal = await api()
      .post(`/entries/${posted.body.id}/reverse`)
      .set('Authorization', auth())
      .send({});

    const response = await api()
      .get(`/entries/${reversal.body.id}`)
      .set('Authorization', auth());

    expect(response.body).toMatchObject({ reversalOf: posted.body.id, reversedBy: null });
  });

  it('answers 404 for an entry that does not exist', async () => {
    const response = await api()
      .get('/entries/3f4d0b7e-9a5e-4c3b-8a52-2c1f5c9a1b23')
      .set('Authorization', auth());

    expect(response.status).toBe(404);
  });
});
```

The last case is worth reading twice: the guard resolves the book from the entry, so an entry that does not exist has no book, and the failure comes from the authorization layer rather than from the handler. Assert the status and let whichever code it produces stand — do not weaken the guard to make a 404 come from the service.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/api test -- --project integration tests/http/reversal.test.ts
```

Expected: FAIL with 404 `ROUTE_NOT_FOUND` on the first three cases.

- [ ] **Step 3: Add the service method**

In `apps/api/src/services/ledger.service.ts`:

```ts
  /**
   * One entry, with the reversal that cancels it if there is one.
   *
   * Two queries in one transaction rather than a join: `findReversalOf` is an index lookup
   * on a column that is null for almost every row, and joining it would repeat every entry
   * column once per leg for the sake of one nullable id.
   *
   * `reversedBy` is what lets the reversal screen disable an action whose only possible
   * outcome is `ENTRY_ALREADY_REVERSED`. The entry itself carries `reversalOf`, the link in
   * the other direction, and neither can be derived from the other in one direction of read.
   */
  async getEntry(
    bookId: string,
    entryId: string,
  ): Promise<{ entry: EntryRecord; reversedBy: string | null }> {
    return this.unitOfWork.transactionInBook(bookId, async (tx) => {
      const entry = await this.repository.findEntryById(tx, entryId);
      if (entry === null) throw new EntryNotFoundError(entryId);

      const reversal = await this.repository.findReversalOf(tx, entryId);
      return { entry, reversedBy: reversal?.id ?? null };
    });
  }
```

`EntryNotFoundError` is already imported in this file by `reverseEntry`; confirm the constructor's parameters against its declaration in `apps/api/src/domain/errors.ts` and match them.

- [ ] **Step 4: Add the route and its registry row**

In `apps/api/src/routes/ledger.routes.ts`:

```ts
  const getEntry: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const entryId = uuidPathParam(request.params, 'entryId');

    const { entry, reversedBy } = await ledger.getEntry(bookId, entryId);

    response.json(serializeEntry(entry, reversedBy));
  };
```

```ts
    {
      method: 'get',
      path: '/entries/:entryId',
      access: { kind: 'book', permission: 'book:read', bookFrom: 'entry' },
      summary: 'Read one entry and the reversal that cancels it',
      handler: getEntry,
    },
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
pnpm --filter @ledger/api test -- --project integration tests/http/reversal.test.ts tests/http/routes.meta.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run everything**

```bash
pnpm --filter @ledger/api test
```

```bash
pnpm --filter @ledger/shared test
```

Expected: PASS. The property suite drives `LedgerService` through a command sequence and is the one most likely to notice an accidental behaviour change in `serializeEntry`.

- [ ] **Step 7: Update the README**

In `README.md`, the Layout block says `apps/web  stage 6`. Leave it — plan 2 fills that in. Add to the service-layer section one paragraph stating that the request schemas and response types now live in `packages/shared`, and why: the frontend gates its submit button on the same zero-sum rule the service enforces, and two copies of that rule would eventually disagree in the direction of offering a button that cannot work.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/api README.md
git commit -m "feat(ledger): read one entry, and say whether it has already been reversed"
```

---

## Done when

- `pnpm lint`, `pnpm typecheck` and `pnpm test` all pass from the repository root.
- `packages/shared` exports every request schema and response type the spec's contract section names, and `apps/api` declares none of them locally.
- `GET /books`, `GET /books/:bookId/accounts` and `GET /entries/:entryId` are served, each with a registry row, and `routes.meta.test.ts` agrees.
- `BookResource` carries `role`; `EntryResource` carries `reversedBy`; `AccountResource` carries `parentId`.
- No behaviour visible to an existing test has changed except the three added fields.

Plan 2 (`apps/web` scaffold, `apiFetch`, session, login, register, book picker) can then begin against a stable contract.
