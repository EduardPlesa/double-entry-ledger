# Stage 6, plan 3 — the five screens

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the five screens the stage exists for — the entry composer first, then the account tree, account detail, the trial balance, and the reversal flow — and one end-to-end path through a real API that proves the wiring underneath them works.

**Architecture:** Each screen is a route component over a TanStack Query hook and `apiFetch`. The composer's arithmetic lives in a pure module with no React in it, so the rule that decides whether an entry balances is tested as a function over values rather than through a rendered form. Money never becomes a `number`: leg amounts are strings from the input, `Money` in between, and decimal strings on the wire.

**Tech Stack:** React 19, TanStack Query v5, React Hook Form, Zod schemas from `@ledger/shared`, Tailwind, React Router v7, Vitest/jsdom with MSW, Playwright.

This is plan 3 of 3 for stage 6. Plan 1 (the shared contract and three read endpoints) and plan 2 (the scaffold, `apiFetch`, the session, auth screens and the book picker) are merged. Nothing here changes `apps/api` or `packages/shared`.

Spec: `docs/superpowers/specs/2026-08-05-stage-6-frontend-design.md`.

## Global Constraints

- Node >= 22, pnpm 11.8.0. Never `npm` or `yarn`. New dependencies install with `pnpm add -E` so the resolved exact version lands in `package.json`; this repo pins with no `^` or `~`.
- **Money is never a JS `number`.** Amounts are strings at the input and on the wire, and `Money` (a `bigint` and a currency) in between. `Number(`, `parseFloat`, `parseInt`, `toFixed` and `+` on an amount are all defects. Use `parseMoney`, `formatMoney`, `sumMoney`, `addMoney`, `subtractMoney`, `negateMoney`, `compareMoney`, `isZeroMoney`, `isNegativeMoney` from `@ledger/shared`.
- **Zero-sum is per currency.** An entry may carry legs in more than one currency; each currency sums to zero on its own. Never add across currencies, and never render a total that does.
- `apps/web` is `"moduleResolution": "Bundler"`: imports carry **no** `.js` extension. `apps/api` and `packages/shared` are NodeNext and require it.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax` are inherited from `tsconfig.base.json` and stay on.
- React 19 idioms are deliberate in this package: `use(Context)` not `useContext`, `<Context value={…}>` not `<Context.Provider>`.
- `react-hooks` lint rules are active. If `exhaustive-deps` objects, fix the dependency rather than silencing the rule.
- Every API call goes through `apiFetch`. `grep -rn "fetch(" apps/web/src` must find it only in `api/client.ts` and `api/session.ts`.
- Every query key comes from `src/api/keys.ts`. A key spelled inline is an invalidation nobody can grep for.
- **No optimistic updates.** The overdraft rule means the server may refuse a write the client believes is fine, and a ledger that shows a posting that was rejected is worse than one that shows a spinner.
- `process.env` may be read only in `apps/api/src/config.ts`.
- **Before every commit run `pnpm typecheck` and `pnpm lint` from the repository root and `pnpm --filter @ledger/web test`, and read each one's output.** Quote all three in the task report.
- Commit messages are conventional and lowercase, in the style of `git log`. No attribution footer, no co-author trailer.

## File Structure

**`apps/web/src/entries/legs.ts`** (new) — the composer's arithmetic, with no React: parsing a row into a signed `Money`, grouping by currency, and deciding whether the form may submit. Pure functions over values, so the rule that greys out the submit button is tested directly.

**`apps/web/src/entries/Composer.tsx`** (new) — the leg table, the imbalance strip, and submit. Consumes `legs.ts` for every decision.

**`apps/web/src/accounts/`** (new) — `useAccounts`, the create-account form, the tree, and account detail. One file per responsibility; the tree's grouping logic goes in `tree.ts` beside it, pure, for the same reason as `legs.ts`.

**`apps/web/src/reports/TrialBalance.tsx`** (new) — the report.

**`apps/web/src/entries/Reversal.tsx`** (new) — the before/after preview and confirmation.

**`apps/web/e2e/`** (new) — the Playwright spec and its configuration.

Existing files this plan touches: `src/App.tsx` (routes), `src/api/keys.ts` (nothing new — plan 2 already defined every key these screens need), `tests/msw/handlers.ts` (fixtures for the new endpoints).

---

### Task 1: Accounts, and a form to create one

**Files:**
- Create: `apps/web/src/accounts/useAccounts.ts`, `apps/web/src/accounts/AccountForm.tsx`
- Create: `apps/web/tests/accounts/AccountForm.test.tsx`
- Modify: `apps/web/tests/msw/handlers.ts`

**Interfaces:**
- Consumes: `apiFetch`, `keys.accounts`, `useToast`, `FieldError`, and `createAccountInput` / `AccountResource` / `AccountType` from `@ledger/shared`.
- Produces: `useAccounts(bookId): UseQueryResult<AccountResource[]>` and `<AccountForm bookId={…} />`. Every later task in this plan reads accounts through `useAccounts`.

A fresh book has no accounts, so the composer would have nothing to pick. This lands first for the same reason create-book landed before the books list.

- [ ] **Step 1: Add fixtures the later tasks also use**

In `apps/web/tests/msw/handlers.ts`, add beside `BOOKS`:

```ts
import type { AccountResource } from '@ledger/shared';

export const ACCOUNTS: AccountResource[] = [
  {
    id: 'acc-cash',
    bookId: 'book-1',
    name: 'Cash',
    type: 'asset',
    currency: 'EUR',
    parentId: null,
    closedAt: null,
  },
  {
    id: 'acc-sales',
    bookId: 'book-1',
    name: 'Sales',
    type: 'revenue',
    currency: 'EUR',
    parentId: null,
    closedAt: null,
  },
];
```

and a handler in the exported array:

```ts
  http.get('/books/:bookId/accounts', () => HttpResponse.json(ACCOUNTS)),
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/tests/accounts/AccountForm.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { AccountForm } from '../../src/accounts/AccountForm';
import { ToastProvider } from '../../src/toast/ToastProvider';
import { server } from '../msw/server';

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AccountForm bookId="book-1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AccountForm', () => {
  it('creates an account with the five types offered and nothing else', async () => {
    const user = userEvent.setup();
    let sent: unknown = null;

    server.use(
      http.post('/books/:bookId/accounts', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ id: 'acc-new' }, { status: 201 });
      }),
    );

    renderForm();

    await user.type(screen.getByLabelText(/name/i), 'Rent');
    await user.selectOptions(screen.getByLabelText(/type/i), 'expense');
    await user.type(screen.getByLabelText(/currency/i), 'EUR');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await screen.findByRole('button', { name: /create account/i });
    expect(sent).toEqual({ name: 'Rent', type: 'expense', currency: 'EUR' });

    const options = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(options).toEqual(['asset', 'liability', 'equity', 'revenue', 'expense']);
  });

  it('rejects a lowercase currency without calling the API', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/books/:bookId/accounts', () => {
        throw new Error('the API must not be called for a currency the schema rejects');
      }),
    );

    renderForm();

    await user.type(screen.getByLabelText(/name/i), 'Rent');
    await user.selectOptions(screen.getByLabelText(/type/i), 'expense');
    await user.type(screen.getByLabelText(/currency/i), 'eur');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/three-letter ISO 4217 code/i)).toBeInTheDocument();
  });

  it('surfaces a refusal as a toast carrying the request id', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/books/:bookId/accounts', () =>
        HttpResponse.json(
          { status: 422, code: 'CURRENCY_MISMATCH', detail: 'the parent holds USD', requestId: 'req-acc' },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    renderForm();

    await user.type(screen.getByLabelText(/name/i), 'Rent');
    await user.selectOptions(screen.getByLabelText(/type/i), 'expense');
    await user.type(screen.getByLabelText(/currency/i), 'EUR');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('the parent holds USD')).toBeInTheDocument();
    expect(screen.getByText('req-acc')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/accounts/AccountForm.test.tsx
```

Expected: FAIL — cannot resolve `../../src/accounts/AccountForm`.

- [ ] **Step 4: Write the query hook**

Create `apps/web/src/accounts/useAccounts.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import type { AccountResource } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';

/**
 * Every account in a book, in one request.
 *
 * One query, not one per account: the API returns the whole book's accounts ordered by type
 * then name, and the tree, the composer's account picker and the reversal preview all read
 * from this same cache entry rather than each fetching their own.
 */
export function useAccounts(bookId: string) {
  return useQuery({
    queryKey: keys.accounts(bookId),
    queryFn: () => apiFetch<AccountResource[]>(`/books/${bookId}/accounts`),
  });
}
```

- [ ] **Step 5: Write the form**

Create `apps/web/src/accounts/AccountForm.tsx`:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { createAccountInput, type AccountResource, type CreateAccountInput } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';
import { FieldError } from '../forms/FieldError';
import { useToast } from '../toast/ToastProvider';

/**
 * The five types are the five of double-entry bookkeeping, and they come from the same Zod
 * enum the service validates against - so a sixth cannot appear here without appearing there.
 */
const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export function AccountForm({ bookId }: { bookId: string }) {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const form = useForm<CreateAccountInput>({ resolver: zodResolver(createAccountInput) });

  const create = useMutation({
    mutationFn: (input: CreateAccountInput) =>
      apiFetch<AccountResource>(`/books/${bookId}/accounts`, { method: 'POST', body: input }),
    onSuccess: async () => {
      form.reset();
      await queryClient.invalidateQueries({ queryKey: keys.accounts(bookId) });
    },
    onError: showError,
  });

  const onSubmit = form.handleSubmit((values) => {
    create.mutate(values);
  });

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        Name
        <input {...form.register('name')} className="border p-2" />
      </label>
      <FieldError message={form.formState.errors.name?.message} />

      <label className="flex flex-col gap-1">
        Type
        <select {...form.register('type')} className="border p-2">
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <FieldError message={form.formState.errors.type?.message} />

      <label className="flex flex-col gap-1">
        Currency
        <input {...form.register('currency')} className="border p-2" />
      </label>
      <FieldError message={form.formState.errors.currency?.message} />

      <button type="submit" disabled={create.isPending} className="border p-2">
        Create account
      </button>
    </form>
  );
}
```

`parentId` is deliberately not offered. The tree renders a hierarchy the API already supports, but choosing a parent is a picker with its own validation — same book, same currency — and nothing in this stage needs it. The field stays absent rather than present and broken.

- [ ] **Step 6: Run the test and watch it pass**

```bash
pnpm --filter @ledger/web test -- tests/accounts/AccountForm.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): the accounts of a book, and a form to add one"
```

---

### Task 2: The composer's arithmetic

**Files:**
- Create: `apps/web/src/entries/legs.ts`
- Create: `apps/web/tests/entries/legs.test.ts`

**Interfaces:**
- Consumes: `Money`, `parseMoney`, `formatMoney`, `sumMoney`, `negateMoney`, `isZeroMoney`, `minorUnitDigits` from `@ledger/shared`; `AccountResource`.
- Produces:
  - `interface LegRow { accountId: string; debit: string; credit: string }`
  - `type LegProblem = 'no-account' | 'both-columns' | 'no-amount' | 'unparseable' | 'zero'`
  - `function legProblem(row: LegRow, currency: string | null): LegProblem | null`
  - `function signedAmount(row: LegRow, currency: string): Money | null`
  - `function imbalances(rows, accountsById): { currency: string; delta: Money }[]` — one entry per currency present, `delta` the debits-minus-credits total, including the zero ones
  - `function canSubmit(rows, accountsById): boolean`
  - `function remainderFor(rows, accountsById, index): string | null` — what to put in the empty cell of row `index` to bring its currency to zero, as a decimal string, or null if there is nothing to place
  - `function remainderColumn(rows, accountsById, index): 'debit' | 'credit' | null` — which column that amount belongs in
  - `function currencyOf(row, accountsById): string | null` — the row's currency, taken from its account

Task 3 renders these; nothing here imports React.

This module is the centrepiece's actual subject. The submit button is greyed out by `canSubmit`, and the strip above it renders `imbalances`. Testing it as functions over values is what makes those rules checkable without a rendered form.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/entries/legs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatMoney, type AccountResource } from '@ledger/shared';
import {
  canSubmit,
  imbalances,
  legProblem,
  remainderFor,
  signedAmount,
  type LegRow,
} from '../../src/entries/legs';

function account(id: string, currency: string): AccountResource {
  return { id, bookId: 'book-1', name: id, type: 'asset', currency, parentId: null, closedAt: null };
}

const ACCOUNTS = new Map([
  ['eur-a', account('eur-a', 'EUR')],
  ['eur-b', account('eur-b', 'EUR')],
  ['usd-a', account('usd-a', 'USD')],
  ['jpy-a', account('jpy-a', 'JPY')],
]);

function row(overrides: Partial<LegRow> = {}): LegRow {
  return { accountId: 'eur-a', debit: '', credit: '', ...overrides };
}

describe('legProblem', () => {
  it('accepts a row with one column filled', () => {
    expect(legProblem(row({ debit: '10.00' }), 'EUR')).toBeNull();
    expect(legProblem(row({ credit: '10.00' }), 'EUR')).toBeNull();
  });

  it('names each way a row can be wrong', () => {
    expect(legProblem(row({ accountId: '', debit: '10.00' }), null)).toBe('no-account');
    expect(legProblem(row({ debit: '10.00', credit: '10.00' }), 'EUR')).toBe('both-columns');
    expect(legProblem(row(), 'EUR')).toBe('no-amount');
    expect(legProblem(row({ debit: 'ten' }), 'EUR')).toBe('unparseable');
    expect(legProblem(row({ debit: '0.00' }), 'EUR')).toBe('zero');
  });

  it('rejects more decimal places than the currency has', () => {
    expect(legProblem(row({ accountId: 'jpy-a', debit: '10.5' }), 'JPY')).toBe('unparseable');
    expect(legProblem(row({ accountId: 'eur-a', debit: '10.005' }), 'EUR')).toBe('unparseable');
  });
});

describe('signedAmount', () => {
  it('makes a debit positive and a credit negative', () => {
    expect(formatMoney(signedAmount(row({ debit: '10.00' }), 'EUR')!)).toBe('10.00');
    expect(formatMoney(signedAmount(row({ credit: '10.00' }), 'EUR')!)).toBe('-10.00');
  });

  it('returns null for a row that is not usable', () => {
    expect(signedAmount(row({ debit: 'ten' }), 'EUR')).toBeNull();
    expect(signedAmount(row(), 'EUR')).toBeNull();
  });
});

describe('imbalances', () => {
  it('reports one delta per currency, including the balanced ones', () => {
    const result = imbalances(
      [
        row({ accountId: 'eur-a', debit: '10.00' }),
        row({ accountId: 'eur-b', credit: '5.80' }),
        row({ accountId: 'usd-a', debit: '3.00' }),
      ],
      ACCOUNTS,
    );

    expect(result.map((entry) => [entry.currency, formatMoney(entry.delta)])).toEqual([
      ['EUR', '4.20'],
      ['USD', '3.00'],
    ]);
  });

  it('is zero for each currency when the entry balances', () => {
    const result = imbalances(
      [
        row({ accountId: 'eur-a', debit: '10.00' }),
        row({ accountId: 'eur-b', credit: '10.00' }),
        row({ accountId: 'usd-a', debit: '3.00' }),
        row({ accountId: 'usd-a', credit: '3.00' }),
      ],
      ACCOUNTS,
    );

    expect(result.map((entry) => formatMoney(entry.delta))).toEqual(['0.00', '0.00']);
  });

  it('never adds across currencies', () => {
    const result = imbalances(
      [row({ accountId: 'eur-a', debit: '10.00' }), row({ accountId: 'usd-a', credit: '10.00' })],
      ACCOUNTS,
    );

    expect(result).toHaveLength(2);
    expect(result.map((entry) => formatMoney(entry.delta))).toEqual(['10.00', '-10.00']);
  });

  it('ignores rows that cannot be read yet, so the strip updates while typing', () => {
    const result = imbalances(
      [row({ accountId: 'eur-a', debit: '10.00' }), row({ accountId: 'eur-b', credit: '' })],
      ACCOUNTS,
    );

    expect(formatMoney(result[0]!.delta)).toBe('10.00');
  });
});

describe('canSubmit', () => {
  const balanced: LegRow[] = [
    row({ accountId: 'eur-a', debit: '10.00' }),
    row({ accountId: 'eur-b', credit: '10.00' }),
  ];

  it('allows a balanced pair', () => {
    expect(canSubmit(balanced, ACCOUNTS)).toBe(true);
  });

  it('refuses fewer than two legs, however balanced', () => {
    expect(canSubmit([row({ debit: '0.00' })], ACCOUNTS)).toBe(false);
  });

  it('refuses an unbalanced entry', () => {
    expect(canSubmit([balanced[0]!, row({ accountId: 'eur-b', credit: '9.00' })], ACCOUNTS)).toBe(false);
  });

  it('refuses when any row is wrong, even if the rest balance', () => {
    expect(canSubmit([...balanced, row({ accountId: 'eur-a' })], ACCOUNTS)).toBe(false);
    expect(canSubmit([...balanced, row({ accountId: '', debit: '1.00' })], ACCOUNTS)).toBe(false);
  });

  it('refuses when one currency balances and another does not', () => {
    expect(canSubmit([...balanced, row({ accountId: 'usd-a', debit: '1.00' })], ACCOUNTS)).toBe(false);
  });
});

describe('remainderFor', () => {
  it('gives the amount that would bring the row\'s currency to zero', () => {
    const rows = [row({ accountId: 'eur-a', debit: '10.00' }), row({ accountId: 'eur-b' })];

    expect(remainderFor(rows, ACCOUNTS, 1)).toBe('10.00');
  });

  it('gives nothing when the currency already balances', () => {
    const rows = [
      row({ accountId: 'eur-a', debit: '10.00' }),
      row({ accountId: 'eur-b', credit: '10.00' }),
      row({ accountId: 'eur-a' }),
    ];

    expect(remainderFor(rows, ACCOUNTS, 2)).toBeNull();
  });

  it('gives nothing for a row with no account, since its currency is unknown', () => {
    expect(remainderFor([row({ accountId: '' })], ACCOUNTS, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/entries/legs.test.ts
```

Expected: FAIL — cannot resolve `../../src/entries/legs`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/entries/legs.ts`:

```ts
import {
  formatMoney,
  isZeroMoney,
  negateMoney,
  parseMoney,
  sumMoney,
  type AccountResource,
  type Money,
} from '@ledger/shared';

/**
 * Whether an entry balances, and by how much - as functions over values.
 *
 * No React here on purpose. The rule that greys out the submit button is the same rule the
 * database enforces in a deferred constraint trigger, and it deserves to be checked directly
 * rather than through a rendered form. Everything the composer decides, it decides here.
 *
 * Debits are positive and credits negative. The API takes one signed amount per leg, which is
 * the right boundary; two columns are what a person keeping books expects to type into, and
 * the sign is derived from which column they used rather than from a character they might
 * forget.
 */

export interface LegRow {
  readonly accountId: string;
  readonly debit: string;
  readonly credit: string;
}

export type LegProblem = 'no-account' | 'both-columns' | 'no-amount' | 'unparseable' | 'zero';

export type AccountsById = ReadonlyMap<string, AccountResource>;

/** What is wrong with this row, or null if nothing is. */
export function legProblem(row: LegRow, currency: string | null): LegProblem | null {
  if (row.accountId === '' || currency === null) return 'no-account';

  const debit = row.debit.trim();
  const credit = row.credit.trim();

  if (debit !== '' && credit !== '') return 'both-columns';
  if (debit === '' && credit === '') return 'no-amount';

  const amount = tryParse(debit === '' ? credit : debit, currency);
  if (amount === null) return 'unparseable';

  // A zero leg carries no accounting meaning, and `postings_amount_nonzero` rejects it. Saying
  // so here costs a glance; discovering it at the server costs a round trip and a worse message.
  if (isZeroMoney(amount)) return 'zero';

  return null;
}

/** The row as the API wants it: one signed amount. Null when the row is not usable. */
export function signedAmount(row: LegRow, currency: string): Money | null {
  if (legProblem(row, currency) !== null) return null;

  const debit = row.debit.trim();
  const parsed = tryParse(debit === '' ? row.credit.trim() : debit, currency);
  if (parsed === null) return null;

  return debit === '' ? negateMoney(parsed) : parsed;
}

/**
 * One delta per currency present, debits minus credits, in the order the currencies first
 * appear. Balanced currencies are included rather than filtered out: "EUR balanced" beside
 * "USD unbalanced by 3.00" is what tells someone the EUR half is done.
 *
 * Rows that cannot be read yet are skipped rather than treated as errors, so the strip keeps
 * updating while a number is half-typed.
 */
export function imbalances(
  rows: readonly LegRow[],
  accountsById: AccountsById,
): { currency: string; delta: Money }[] {
  const byCurrency = new Map<string, Money[]>();

  for (const row of rows) {
    const currency = currencyOf(row, accountsById);
    if (currency === null) continue;

    const amount = signedAmount(row, currency);
    const amounts = byCurrency.get(currency) ?? [];
    byCurrency.set(currency, amount === null ? amounts : [...amounts, amount]);
  }

  return [...byCurrency].map(([currency, amounts]) => ({
    currency,
    delta: sumMoney(amounts, currency),
  }));
}

/** Whether the form may be submitted. Every condition, in one place. */
export function canSubmit(rows: readonly LegRow[], accountsById: AccountsById): boolean {
  if (rows.length < 2) return false;

  for (const row of rows) {
    if (legProblem(row, currencyOf(row, accountsById)) !== null) return false;
  }

  return imbalances(rows, accountsById).every((entry) => isZeroMoney(entry.delta));
}

/**
 * What to put in this row's empty cell to bring its currency to zero.
 *
 * The operation someone performs by hand on every journal they write. Returns a magnitude as a
 * decimal string; which column it belongs in is the caller's business, and follows from the
 * sign of the outstanding delta.
 */
export function remainderFor(
  rows: readonly LegRow[],
  accountsById: AccountsById,
  index: number,
): string | null {
  const row = rows[index];
  if (row === undefined) return null;

  const currency = currencyOf(row, accountsById);
  if (currency === null) return null;

  const others = rows.filter((_, position) => position !== index);
  const delta = imbalances(others, accountsById).find((entry) => entry.currency === currency);

  if (delta === undefined || isZeroMoney(delta.delta)) return null;

  return formatMoney(absolute(delta.delta));
}

/** Which column `remainderFor`'s value belongs in: a positive outstanding delta needs a credit. */
export function remainderColumn(
  rows: readonly LegRow[],
  accountsById: AccountsById,
  index: number,
): 'debit' | 'credit' | null {
  const row = rows[index];
  if (row === undefined) return null;

  const currency = currencyOf(row, accountsById);
  if (currency === null) return null;

  const others = rows.filter((_, position) => position !== index);
  const delta = imbalances(others, accountsById).find((entry) => entry.currency === currency);

  if (delta === undefined || isZeroMoney(delta.delta)) return null;

  return delta.delta.amountMinor > 0n ? 'credit' : 'debit';
}

export function currencyOf(row: LegRow, accountsById: AccountsById): string | null {
  return accountsById.get(row.accountId)?.currency ?? null;
}

function absolute(value: Money): Money {
  return value.amountMinor < 0n ? negateMoney(value) : value;
}

/** `parseMoney` throws on anything it does not like; here that is an answer, not a failure. */
function tryParse(text: string, currency: string): Money | null {
  try {
    return parseMoney(text, currency);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm --filter @ledger/web test -- tests/entries/legs.test.ts
```

Expected: PASS, 17 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): whether an entry balances, and by how much, as plain functions"
```

---

### Task 3: The composer

**Files:**
- Create: `apps/web/src/entries/Composer.tsx`
- Create: `apps/web/tests/entries/Composer.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: everything from `legs.ts` (Task 2), `useAccounts` (Task 1), `apiFetch`, `newIdempotencyKey`, `keys`, `useToast`.
- Produces: `<Composer />` at route `/books/:bookId/entries/new`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/entries/Composer.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { USER } from '../msw/handlers';

function signedIn() {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
}

async function openComposer() {
  signedIn();
  window.history.replaceState(null, '', '/books/book-1/entries/new');
  render(<App />);
  return screen.findByRole('heading', { name: /new entry/i });
}

function legRow(index: number) {
  return within(screen.getAllByRole('row')[index + 1]!);
}

async function fillLeg(index: number, accountId: string, column: 'debit' | 'credit', amount: string) {
  const user = userEvent.setup();
  const row = legRow(index);
  await user.selectOptions(row.getByLabelText(/account/i), accountId);
  await user.type(row.getByLabelText(new RegExp(column, 'i')), amount);
}

describe('the composer', () => {
  it('states the imbalance in words and in money as legs are typed', async () => {
    await openComposer();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await fillLeg(1, 'acc-sales', 'credit', '5.80');

    expect(await screen.findByText(/EUR/)).toBeInTheDocument();
    expect(screen.getByText(/debits exceed credits by 4\.20/i)).toBeInTheDocument();
  });

  it('says balanced once the currency sums to zero', async () => {
    await openComposer();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await fillLeg(1, 'acc-sales', 'credit', '10.00');

    expect(await screen.findByText(/balanced/i)).toBeInTheDocument();
  });

  it('keeps submit disabled until every currency is zero', async () => {
    await openComposer();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/description/i), 'a sale');
    expect(screen.getByRole('button', { name: /post entry/i })).toBeDisabled();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    expect(screen.getByRole('button', { name: /post entry/i })).toBeDisabled();

    await fillLeg(1, 'acc-sales', 'credit', '10.00');
    expect(screen.getByRole('button', { name: /post entry/i })).toBeEnabled();
  });

  it('refuses a zero leg, which the database would reject anyway', async () => {
    await openComposer();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/description/i), 'a sale');
    await fillLeg(0, 'acc-cash', 'debit', '0.00');
    await fillLeg(1, 'acc-sales', 'credit', '0.00');

    expect(screen.getByRole('button', { name: /post entry/i })).toBeDisabled();
  });

  it('refuses a row with both columns filled', async () => {
    await openComposer();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/description/i), 'a sale');
    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await user.type(legRow(0).getByLabelText(/credit/i), '10.00');
    await fillLeg(1, 'acc-sales', 'credit', '10.00');

    expect(screen.getByRole('button', { name: /post entry/i })).toBeDisabled();
  });

  it('adds and removes legs', async () => {
    await openComposer();
    const user = userEvent.setup();

    expect(screen.getAllByRole('row')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: /add leg/i }));
    expect(screen.getAllByRole('row')).toHaveLength(4);

    await user.click(within(screen.getAllByRole('row')[3]!).getByRole('button', { name: /remove/i }));
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('balances the outstanding amount onto an empty row', async () => {
    await openComposer();
    const user = userEvent.setup();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await user.selectOptions(legRow(1).getByLabelText(/account/i), 'acc-sales');
    await user.click(legRow(1).getByRole('button', { name: /balance/i }));

    expect(legRow(1).getByLabelText(/credit/i)).toHaveValue('10.00');
  });

  it('shows an imbalance per currency, never one total across them', async () => {
    server.use(
      http.get('/books/:bookId/accounts', () =>
        HttpResponse.json([
          { id: 'acc-cash', bookId: 'book-1', name: 'Cash', type: 'asset', currency: 'EUR', parentId: null, closedAt: null },
          { id: 'acc-usd', bookId: 'book-1', name: 'USD wallet', type: 'asset', currency: 'USD', parentId: null, closedAt: null },
        ]),
      ),
    );

    await openComposer();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await fillLeg(1, 'acc-usd', 'credit', '3.00');

    expect(await screen.findByText(/EUR/)).toBeInTheDocument();
    expect(screen.getByText(/USD/)).toBeInTheDocument();
    expect(screen.queryByText(/7\.00/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/entries/Composer.test.tsx
```

Expected: FAIL — no such route, so the catch-all redirect renders the books screen.

- [ ] **Step 3: Write the composer**

Create `apps/web/src/entries/Composer.tsx`. Submit is Task 4 — this step renders the table, the strip, and the gate, with a submit handler that does nothing yet.

```tsx
import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { formatMoney, negateMoney, type AccountResource, type Money } from '@ledger/shared';
import { useAccounts } from '../accounts/useAccounts';
import {
  canSubmit,
  currencyOf,
  imbalances,
  remainderColumn,
  remainderFor,
  type LegRow,
} from './legs';

/**
 * Where entries are written.
 *
 * The strip above the button is the whole point: the imbalance is stated in words and in money
 * as legs are typed, per currency, and submit is impossible until every currency is zero. The
 * database enforces the same rule in a deferred trigger, so this is a courtesy rather than the
 * enforcement - but it is the difference between a form that teaches double-entry and one that
 * rejects you after a round trip.
 *
 * A leg's currency is not an input. An account holds exactly one currency, which
 * `accounts_id_book_id_currency_key` makes a fact about the database, so choosing the account
 * chooses the currency.
 */

const EMPTY_ROW: LegRow = { accountId: '', debit: '', credit: '' };

export function Composer() {
  const { bookId = '' } = useParams();
  const accounts = useAccounts(bookId);

  const [rows, setRows] = useState<LegRow[]>([EMPTY_ROW, EMPTY_ROW]);
  const [description, setDescription] = useState('');

  const accountsById = useMemo(
    () => new Map((accounts.data ?? []).map((account) => [account.id, account])),
    [accounts.data],
  );

  const deltas = imbalances(rows, accountsById);
  const ready = canSubmit(rows, accountsById) && description.trim() !== '';

  const update = (index: number, patch: Partial<LegRow>) => {
    setRows((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  };

  const balanceOnto = (index: number) => {
    const amount = remainderFor(rows, accountsById, index);
    const column = remainderColumn(rows, accountsById, index);
    if (amount === null || column === null) return;

    update(index, column === 'debit' ? { debit: amount, credit: '' } : { credit: amount, debit: '' });
  };

  return (
    <main className="mx-auto mt-8 w-[52rem]">
      <h1 className="text-2xl font-semibold">New entry</h1>

      <label className="mt-4 flex flex-col gap-1">
        Description
        <input
          value={description}
          onChange={(event) => { setDescription(event.target.value); }}
          className="border p-2"
        />
      </label>

      <table className="mt-6 w-full">
        <thead>
          <tr>
            <th className="text-left">Account</th>
            <th className="text-right">Debit</th>
            <th className="text-right">Credit</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <LegFields
              // The index is the identity here: rows have no id of their own, and reordering
              // is not an operation this form offers.
              key={index}
              row={row}
              accounts={accounts.data ?? []}
              currency={currencyOf(row, accountsById)}
              onChange={(patch) => { update(index, patch); }}
              onBalance={() => { balanceOnto(index); }}
              onRemove={rows.length > 2 ? () => { setRows((current) => current.filter((_, p) => p !== index)); } : null}
            />
          ))}
        </tbody>
      </table>

      <button
        type="button"
        onClick={() => { setRows((current) => [...current, EMPTY_ROW]); }}
        className="mt-2 border p-2 text-sm"
      >
        Add leg
      </button>

      <ImbalanceStrip deltas={deltas} />

      <button type="submit" disabled={!ready} className="mt-4 border p-2 disabled:opacity-50">
        Post entry
      </button>
    </main>
  );
}

function LegFields({
  row,
  accounts,
  currency,
  onChange,
  onBalance,
  onRemove,
}: {
  row: LegRow;
  accounts: readonly AccountResource[];
  currency: string | null;
  onChange: (patch: Partial<LegRow>) => void;
  onBalance: () => void;
  onRemove: (() => void) | null;
}) {
  return (
    <tr>
      <td>
        <select
          aria-label="Account"
          value={row.accountId}
          onChange={(event) => { onChange({ accountId: event.target.value }); }}
          className="w-full border p-1"
        >
          <option value="">Choose an account</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id} disabled={account.closedAt !== null}>
              {account.name} ({account.currency})
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          aria-label="Debit"
          value={row.debit}
          onChange={(event) => { onChange({ debit: event.target.value }); }}
          className="w-full border p-1 text-right"
        />
      </td>
      <td>
        <input
          aria-label="Credit"
          value={row.credit}
          onChange={(event) => { onChange({ credit: event.target.value }); }}
          className="w-full border p-1 text-right"
        />
      </td>
      <td className="whitespace-nowrap text-sm">
        <span className="mr-2 text-gray-500">{currency ?? ''}</span>
        <button type="button" onClick={onBalance} className="underline">
          Balance
        </button>
        {onRemove === null ? null : (
          <button type="button" onClick={onRemove} className="ml-2 underline">
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * One line per currency, because zero-sum is per currency. Two currencies produce two lines and
 * never one sum: adding EUR to USD produces a number that means nothing.
 */
function ImbalanceStrip({ deltas }: { deltas: readonly { currency: string; delta: Money }[] }) {
  if (deltas.length === 0) return null;

  return (
    <ul className="mt-4 flex flex-col gap-1 text-sm">
      {deltas.map((entry) => (
        <li key={entry.currency}>
          <span className="font-semibold">{entry.currency}</span>{' '}
          {entry.delta.amountMinor === 0n ? (
            <span>balanced</span>
          ) : entry.delta.amountMinor > 0n ? (
            <span>debits exceed credits by {formatMoney(entry.delta)}</span>
          ) : (
            <span>credits exceed debits by {formatMoney(negateMoney(entry.delta))}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Add the route**

In `apps/web/src/App.tsx`, inside the `RequireSession` block:

```tsx
                <Route path="/books/:bookId/entries/new" element={<Composer />} />
```

with the import beside the others.

- [ ] **Step 5: Run the test and watch it pass**

```bash
pnpm --filter @ledger/web test -- tests/entries/Composer.test.tsx
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): the composer, and an imbalance stated as it is typed"
```

---

### Task 4: Posting the entry

**Files:**
- Modify: `apps/web/src/entries/Composer.tsx`
- Modify: `apps/web/tests/entries/Composer.test.tsx`

**Interfaces:**
- Consumes: `signedAmount` and `currencyOf` from `legs.ts`, `apiFetch`, `newIdempotencyKey`, `keys`, `useToast`.
- Produces: nothing new; the composer now writes.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/tests/entries/Composer.test.tsx`:

```tsx
describe('posting an entry', () => {
  async function fillBalancedEntry() {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/description/i), 'a sale');
    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await fillLeg(1, 'acc-sales', 'credit', '10.00');
  }

  it('sends debits positive and credits negative, as decimal strings', async () => {
    let sent: { legs?: { amount: string; currency: string; accountId: string }[] } = {};
    server.use(
      http.post('/books/:bookId/entries', async ({ request }) => {
        sent = (await request.json()) as typeof sent;
        return HttpResponse.json({ id: 'entry-1' }, { status: 201 });
      }),
    );

    await openComposer();
    await fillBalancedEntry();
    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));

    await screen.findByText(/recorded/i);
    expect(sent.legs).toEqual([
      { accountId: 'acc-cash', amount: '10.00', currency: 'EUR' },
      { accountId: 'acc-sales', amount: '-10.00', currency: 'EUR' },
    ]);
  });

  it('carries an Idempotency-Key, and the same one on a retry', async () => {
    const keysSeen: (string | null)[] = [];
    server.use(
      http.post('/books/:bookId/entries', ({ request }) => {
        keysSeen.push(request.headers.get('idempotency-key'));
        return keysSeen.length === 1
          ? HttpResponse.json(
              { status: 503, code: 'INTERNAL_ERROR', detail: 'try again', requestId: 'req-1' },
              { status: 503, headers: { 'content-type': 'application/problem+json' } },
            )
          : HttpResponse.json({ id: 'entry-1' }, { status: 201 });
      }),
    );

    await openComposer();
    await fillBalancedEntry();

    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));
    await screen.findByText('req-1');

    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));
    await screen.findByText(/recorded/i);

    expect(keysSeen).toHaveLength(2);
    expect(keysSeen[0]).toBe(keysSeen[1]);
    expect(keysSeen[0]).not.toBeNull();
  });

  it('says an entry already existed when the API answers 200 rather than 201', async () => {
    server.use(
      http.post('/books/:bookId/entries', () => HttpResponse.json({ id: 'entry-1' }, { status: 200 })),
    );

    await openComposer();
    await fillBalancedEntry();
    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));

    expect(await screen.findByText(/already recorded/i)).toBeInTheDocument();
  });

  it('puts a rejected leg on its own row rather than in a toast', async () => {
    server.use(
      http.post('/books/:bookId/entries', () =>
        HttpResponse.json(
          {
            status: 400,
            code: 'VALIDATION_FAILED',
            detail: 'invalid request body',
            requestId: 'req-2',
            errors: [{ path: 'legs.1.amount', message: 'must not be blank' }],
          },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    await openComposer();
    await fillBalancedEntry();
    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));

    expect(await within(screen.getAllByRole('row')[2]!).findByText(/must not be blank/i)).toBeInTheDocument();
  });

  it('names the account and the shortfall when the entry would overdraw one', async () => {
    server.use(
      http.post('/books/:bookId/entries', () =>
        HttpResponse.json(
          {
            status: 422,
            code: 'ACCOUNT_OVERDRAWN',
            detail: 'account acc-cash would be overdrawn',
            requestId: 'req-3',
            accountId: 'acc-cash',
            shortfall: { currency: 'EUR', amount: '5.00' },
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    await openComposer();
    await fillBalancedEntry();
    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));

    expect(await screen.findByText(/would be overdrawn/i)).toBeInTheDocument();
    expect(screen.getByText('req-3')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/entries/Composer.test.tsx
```

Expected: FAIL — nothing is posted, so no confirmation appears.

- [ ] **Step 3: Add the mutation**

In `apps/web/src/entries/Composer.tsx`, add to the imports:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, newIdempotencyKey } from '../api/client';
import { ApiError } from '../api/problem';
import { keys } from '../api/keys';
import { useToast } from '../toast/ToastProvider';
import { signedAmount } from './legs';
import { formatMoney } from '@ledger/shared';
```

and inside `Composer`, before the return:

```tsx
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const [outcome, setOutcome] = useState<'created' | 'existing' | null>(null);
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<number, string>>(new Map());

  // Minted once per composer session and held across retries. A retry that mints a new key is
  // not a retry, it is a second entry - which is the exact failure the header exists to
  // prevent. A new key is taken only after something is actually recorded.
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  const post = useMutation({
    mutationFn: async () => {
      const legs = rows.map((row) => {
        const currency = currencyOf(row, accountsById);
        const amount = currency === null ? null : signedAmount(row, currency);

        // `ready` already proved every row is usable; this is the type narrowing, not a check.
        if (currency === null || amount === null) throw new Error('a leg was not ready to send');

        return { accountId: row.accountId, amount: formatMoney(amount), currency };
      });

      return apiFetch<{ id: string }>(`/books/${bookId}/entries`, {
        method: 'POST',
        idempotencyKey,
        body: { occurredAt: new Date().toISOString(), description: description.trim(), legs },
      });
    },
    onSuccess: async () => {
      setRowErrors(new Map());
      setOutcome('created');
      setIdempotencyKey(newIdempotencyKey());
      setRows([EMPTY_ROW, EMPTY_ROW]);
      setDescription('');

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.trialBalance(bookId, null) }),
        queryClient.invalidateQueries({ queryKey: keys.accounts(bookId) }),
      ]);
    },
    onError: (error: unknown) => {
      const fields = fieldErrorsByRow(error);
      setRowErrors(fields);
      if (fields.size === 0) showError(error);
    },
  });
```

`occurredAt` defaults to now here. Backdating is what the schema is built for and the screen will want a date field eventually; this stage does not add one, and saying so is better than a field that silently sends the wrong instant.

Add below the component:

```tsx
/**
 * `legs.3.amount` becomes row 3.
 *
 * The server validates a list of legs; the form renders a table of rows, and they are the same
 * list in the same order. Anything not shaped like a leg path is left for the toast.
 */
function fieldErrorsByRow(error: unknown): ReadonlyMap<number, string> {
  if (!(error instanceof ApiError)) return new Map();

  const byRow = new Map<number, string>();

  for (const detail of error.errors) {
    const match = /^legs\.(\d+)\./.exec(detail.path);
    if (match?.[1] === undefined) continue;

    byRow.set(Number(match[1]), detail.message);
  }

  return byRow;
}
```

Then wire the UI: give `LegFields` an `error?: string` prop rendered under the row, replace the submit button's `type="submit"` with an `onClick` that calls `post.mutate()`, disable it while `post.isPending`, and render the outcome:

```tsx
      {outcome === 'created' ? <p className="mt-2 text-sm">Entry recorded.</p> : null}
      {outcome === 'existing' ? (
        <p className="mt-2 text-sm">An entry with that external id was already recorded.</p>
      ) : null}
```

**The 200-versus-201 distinction needs the status, which `apiFetch` currently discards.** A `200` means an entry with that `externalId` already existed and this request recorded nothing; calling that "created" would be false, and the status is the only way to tell without diffing bodies.

Widen `RequestOptions` in `src/api/client.ts` with one optional field:

```ts
  /** Called with the status of a successful response. The 200-vs-201 distinction on a POST
   *  is a real answer about what happened, and it is lost if only the body comes back. */
  readonly onStatus?: (status: number) => void;
```

Call it in `apiFetch` immediately before `readBody`, on both the direct and the replayed path. Then the mutation passes `onStatus: (status) => { setOutcome(status === 200 ? 'existing' : 'created'); }`, and `onSuccess` no longer sets `outcome` itself.

Add a test to `apps/web/tests/api/client.test.ts`:

```ts
  it('reports the status of a successful response, so 200 and 201 can be told apart', async () => {
    const seen: number[] = [];
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ id: 'entry-1' }, 201))
      .mockResolvedValueOnce(json({ id: 'entry-1' }, 200));

    const onStatus = (status: number) => seen.push(status);
    await apiFetch('/books/1/entries', { method: 'POST', body: {}, onStatus });
    await apiFetch('/books/1/entries', { method: 'POST', body: {}, onStatus });

    expect(seen).toEqual([201, 200]);
  });
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
pnpm --filter @ledger/web test
```

Expected: PASS, all suites.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): post the entry, once, however many times the button is pressed"
```

---

### Task 5: The account tree

**Files:**
- Create: `apps/web/src/accounts/tree.ts`, `apps/web/src/accounts/AccountTree.tsx`
- Create: `apps/web/tests/accounts/tree.test.ts`, `apps/web/tests/accounts/AccountTree.test.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/tests/msw/handlers.ts`

**Interfaces:**
- Consumes: `useAccounts`, `apiFetch`, `keys.trialBalance`, `TrialBalanceResource`.
- Produces: `buildTree(accounts): TreeNode[]` where `TreeNode = { account: AccountResource; children: TreeNode[] }`; `subtreeTotals(node, balancesById): Money[]`; `<AccountTree />` at `/books/:bookId/accounts`.

- [ ] **Step 1: Add the trial-balance fixture**

In `apps/web/tests/msw/handlers.ts`:

```ts
import type { TrialBalanceResource } from '@ledger/shared';

export const TRIAL_BALANCE: TrialBalanceResource = {
  bookId: 'book-1',
  asOf: null,
  accounts: [
    { accountId: 'acc-cash', name: 'Cash', type: 'asset', currency: 'EUR', balance: '10.00' },
    { accountId: 'acc-sales', name: 'Sales', type: 'revenue', currency: 'EUR', balance: '-10.00' },
  ],
  totals: [{ currency: 'EUR', debits: '10.00', credits: '10.00', balanced: true }],
  balanced: true,
};
```

and the handler:

```ts
  http.get('/books/:bookId/trial-balance', () => HttpResponse.json(TRIAL_BALANCE)),
```

- [ ] **Step 2: Write the failing test for the pure part**

Create `apps/web/tests/accounts/tree.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatMoney, money, type AccountResource } from '@ledger/shared';
import { buildTree, subtreeTotals } from '../../src/accounts/tree';

function account(id: string, parentId: string | null, currency = 'EUR'): AccountResource {
  return { id, bookId: 'book-1', name: id, type: 'asset', currency, parentId, closedAt: null };
}

describe('buildTree', () => {
  it('nests children under their parent and keeps roots in order', () => {
    const tree = buildTree([account('a', null), account('a1', 'a'), account('b', null)]);

    expect(tree.map((node) => node.account.id)).toEqual(['a', 'b']);
    expect(tree[0]!.children.map((node) => node.account.id)).toEqual(['a1']);
  });

  it('treats an account whose parent is absent as a root, rather than dropping it', () => {
    const tree = buildTree([account('orphan', 'missing')]);

    expect(tree.map((node) => node.account.id)).toEqual(['orphan']);
  });
});

describe('subtreeTotals', () => {
  const balances = new Map([
    ['a', money(1000n, 'EUR')],
    ['a1', money(500n, 'EUR')],
    ['usd', money(300n, 'USD')],
  ]);

  it('sums a subtree per currency', () => {
    const tree = buildTree([account('a', null), account('a1', 'a')]);

    expect(subtreeTotals(tree[0]!, balances).map(formatMoney)).toEqual(['15.00']);
  });

  it('never adds across currencies', () => {
    const tree = buildTree([account('a', null), account('usd', 'a', 'USD')]);
    const totals = subtreeTotals(tree[0]!, balances);

    expect(totals.map((total) => `${total.currency} ${formatMoney(total)}`)).toEqual([
      'EUR 10.00',
      'USD 3.00',
    ]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail, then write the module**

```bash
pnpm --filter @ledger/web test -- tests/accounts/tree.test.ts
```

Expected: FAIL — module missing.

Create `apps/web/src/accounts/tree.ts`:

```ts
import { sumMoney, type AccountResource, type Money } from '@ledger/shared';

/**
 * The hierarchy, from the flat list the API returns.
 *
 * `parentId` is the only thing that makes this a tree, which is why plan 1 added it to
 * `AccountResource` - the trial balance carries balances but not parents, so neither endpoint
 * alone can draw this screen.
 */

export interface TreeNode {
  readonly account: AccountResource;
  readonly children: TreeNode[];
}

export function buildTree(accounts: readonly AccountResource[]): TreeNode[] {
  const nodes = new Map(accounts.map((account) => [account.id, { account, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];

  for (const node of nodes.values()) {
    const parentId = node.account.parentId;
    const parent = parentId === null ? undefined : nodes.get(parentId);

    // An account whose parent is not in this list is shown as a root rather than hidden. The
    // API cannot produce one - a parent must live in the same book - but a screen that silently
    // drops rows is worse than one that shows an odd hierarchy.
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }

  return roots;
}

/**
 * The subtree's balance, one total per currency.
 *
 * Per currency because a parent may hold accounts denominated differently, and the sum of a EUR
 * balance and a USD one is a number that means nothing. Two currencies produce two lines.
 */
export function subtreeTotals(node: TreeNode, balancesById: ReadonlyMap<string, Money>): Money[] {
  const byCurrency = new Map<string, Money[]>();

  const walk = (current: TreeNode): void => {
    const balance = balancesById.get(current.account.id);
    if (balance !== undefined) {
      byCurrency.set(balance.currency, [...(byCurrency.get(balance.currency) ?? []), balance]);
    }

    for (const child of current.children) walk(child);
  };

  walk(node);

  return [...byCurrency]
    .map(([currency, amounts]) => sumMoney(amounts, currency))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}
```

- [ ] **Step 4: Write the failing screen test**

Create `apps/web/tests/accounts/AccountTree.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { ACCOUNTS, USER } from '../msw/handlers';

async function openTree() {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
  window.history.replaceState(null, '', '/books/book-1/accounts');
  render(<App />);
  return screen.findByRole('heading', { name: /accounts/i });
}

describe('the account tree', () => {
  it('shows each account with its balance', async () => {
    await openTree();

    expect(await screen.findByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('10.00')).toBeInTheDocument();
    expect(screen.getByText('-10.00')).toBeInTheDocument();
  });

  it('nests a child under its parent', async () => {
    server.use(
      http.get('/books/:bookId/accounts', () =>
        HttpResponse.json([
          ...ACCOUNTS,
          { id: 'acc-petty', bookId: 'book-1', name: 'Petty cash', type: 'asset', currency: 'EUR', parentId: 'acc-cash', closedAt: null },
        ]),
      ),
    );

    await openTree();

    const petty = await screen.findByText('Petty cash');
    expect(petty.closest('li')?.parentElement?.closest('li')).toHaveTextContent('Cash');
  });

  it('hides closed accounts behind a toggle', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/books/:bookId/accounts', () =>
        HttpResponse.json([
          ...ACCOUNTS,
          { id: 'acc-old', bookId: 'book-1', name: 'Old account', type: 'asset', currency: 'EUR', parentId: null, closedAt: '2026-01-01T00:00:00.000Z' },
        ]),
      ),
    );

    await openTree();
    expect(await screen.findByText('Old account')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /show closed/i }));
    expect(screen.queryByText('Old account')).not.toBeInTheDocument();
  });

  it('links each account to its detail', async () => {
    await openTree();

    expect(await screen.findByRole('link', { name: 'Cash' })).toHaveAttribute('href', '/accounts/acc-cash');
  });
});
```

- [ ] **Step 5: Write the screen**

Create `apps/web/src/accounts/AccountTree.tsx`. It reads accounts and the trial balance, joins them on `accountId`, and renders nested `<ul>`s. Two requests, not one per account: the trial balance is a fixed number of queries regardless of how many accounts a book has, which `query-count.test.ts` in the API asserts, and an N+1 in the client would give that away for nothing.

```tsx
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { formatMoney, parseMoney, type Money, type TrialBalanceResource } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';
import { AccountForm } from './AccountForm';
import { buildTree, subtreeTotals, type TreeNode } from './tree';
import { useAccounts } from './useAccounts';

export function AccountTree() {
  const { bookId = '' } = useParams();
  const accounts = useAccounts(bookId);
  const [showClosed, setShowClosed] = useState(true);

  const trialBalance = useQuery({
    queryKey: keys.trialBalance(bookId, null),
    queryFn: () => apiFetch<TrialBalanceResource>(`/books/${bookId}/trial-balance`),
  });

  const balancesById = useMemo(() => {
    const entries = (trialBalance.data?.accounts ?? []).map(
      (line) => [line.accountId, parseMoney(line.balance, line.currency)] as const,
    );
    return new Map<string, Money>(entries);
  }, [trialBalance.data]);

  const visible = (accounts.data ?? []).filter(
    (account) => showClosed || account.closedAt === null,
  );

  return (
    <main className="mx-auto mt-8 w-[44rem]">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <nav className="flex gap-3 text-sm">
          <Link to={`/books/${bookId}/entries/new`} className="underline">
            New entry
          </Link>
          <Link to={`/books/${bookId}/trial-balance`} className="underline">
            Trial balance
          </Link>
        </nav>
      </div>

      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showClosed}
          onChange={(event) => { setShowClosed(event.target.checked); }}
        />
        Show closed accounts
      </label>

      <ul className="mt-4 flex flex-col gap-1">
        {buildTree(visible).map((node) => (
          <TreeRow key={node.account.id} node={node} balancesById={balancesById} />
        ))}
      </ul>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Add an account</h2>
        <AccountForm bookId={bookId} />
      </section>
    </main>
  );
}

function TreeRow({ node, balancesById }: { node: TreeNode; balancesById: ReadonlyMap<string, Money> }) {
  const own = balancesById.get(node.account.id);
  const totals = node.children.length === 0 ? [] : subtreeTotals(node, balancesById);

  return (
    <li className={node.account.closedAt === null ? '' : 'text-gray-400'}>
      <div className="flex items-center justify-between border-b py-1">
        <Link to={`/accounts/${node.account.id}`} className="underline">
          {node.account.name}
        </Link>
        <span className="text-sm">
          {own === undefined ? '' : formatMoney(own)} {node.account.currency}
        </span>
      </div>

      {totals.length === 0 ? null : (
        <p className="pl-4 text-xs text-gray-600">
          including children: {totals.map((total) => `${formatMoney(total)} ${total.currency}`).join(', ')}
        </p>
      )}

      {node.children.length === 0 ? null : (
        <ul className="pl-4">
          {node.children.map((child) => (
            <TreeRow key={child.account.id} node={child} balancesById={balancesById} />
          ))}
        </ul>
      )}
    </li>
  );
}
```

Add the route `/books/:bookId/accounts` to `App.tsx` inside `RequireSession`.

- [ ] **Step 6: Run the tests, typecheck, lint, commit**

```bash
pnpm --filter @ledger/web test
```

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): the account tree, with what each subtree holds per currency"
```

---

### Task 6: Account detail

**Files:**
- Create: `apps/web/src/accounts/AccountDetail.tsx`
- Create: `apps/web/tests/accounts/AccountDetail.test.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/tests/msw/handlers.ts`

**Interfaces:**
- Consumes: `apiFetch`, `keys.postings`, `keys.balance`, `PostingPageResource`, `BalanceResource`.
- Produces: `<AccountDetail />` at `/accounts/:accountId`.

- [ ] **Step 1: Add fixtures**

In `handlers.ts`, a two-page postings fixture and a balance:

```ts
import type { BalanceResource, PostingPageResource } from '@ledger/shared';

export const POSTINGS_PAGE_ONE: PostingPageResource = {
  accountId: 'acc-cash',
  items: [
    {
      id: '1',
      entryId: 'entry-1',
      occurredAt: '2026-03-01T12:00:00.000Z',
      recordedAt: '2026-03-01T12:00:00.000Z',
      description: 'a sale',
      amount: '10.00',
      runningBalance: '10.00',
      currency: 'EUR',
    },
  ],
  nextCursor: 'cursor-2',
};

export const POSTINGS_PAGE_TWO: PostingPageResource = {
  accountId: 'acc-cash',
  items: [
    {
      id: '2',
      entryId: 'entry-2',
      occurredAt: '2026-03-02T12:00:00.000Z',
      recordedAt: '2026-03-02T12:00:00.000Z',
      description: 'rent',
      amount: '-4.00',
      runningBalance: '6.00',
      currency: 'EUR',
    },
  ],
  nextCursor: null,
};

export const BALANCE: BalanceResource = {
  accountId: 'acc-cash',
  asOf: null,
  balance: '6.00',
  currency: 'EUR',
};
```

and handlers that page on the cursor:

```ts
  http.get('/accounts/:accountId/postings', ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor');
    return HttpResponse.json(cursor === null ? POSTINGS_PAGE_ONE : POSTINGS_PAGE_TWO);
  }),
  http.get('/accounts/:accountId/balance', () => HttpResponse.json(BALANCE)),
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/tests/accounts/AccountDetail.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { USER } from '../msw/handlers';

async function openDetail() {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
  window.history.replaceState(null, '', '/accounts/acc-cash');
  render(<App />);
  return screen.findByRole('heading', { name: /cash|account/i });
}

describe('account detail', () => {
  it('shows the current balance', async () => {
    await openDetail();

    expect(await screen.findByText('6.00')).toBeInTheDocument();
  });

  it('lists postings with the running balance the server computed', async () => {
    await openDetail();

    expect(await screen.findByText('a sale')).toBeInTheDocument();

    // Two matches on purpose: the posting's amount and the running balance after it are both
    // 10.00 on the first page, so `getAllByText` is the honest matcher here.
    expect(screen.getAllByText('10.00')).toHaveLength(2);
  });

  it('loads the next page from the cursor', async () => {
    const user = userEvent.setup();
    await openDetail();
    await screen.findByText('a sale');

    await user.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('rent')).toBeInTheDocument();
  });

  it('stops offering more when the cursor runs out', async () => {
    const user = userEvent.setup();
    await openDetail();
    await screen.findByText('a sale');

    await user.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findByText('rent');

    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('links a posting to the entry it belongs to', async () => {
    await openDetail();

    expect(await screen.findByRole('link', { name: /a sale/i })).toHaveAttribute(
      'href',
      '/entries/entry-1/reverse',
    );
  });
});
```

- [ ] **Step 3: Write the screen**

Create `apps/web/src/accounts/AccountDetail.tsx`, using `useInfiniteQuery` with `nextCursor` as the page param. The running balance is the server's column, rendered as received — recomputing it client-side would create a second authority on the `(occurred_at, id)` ordering that the API's property suite checks twice precisely because that tiebreaker is where a disagreement would hide.

```tsx
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import type { BalanceResource, PostingPageResource } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';

export function AccountDetail() {
  const { accountId = '' } = useParams();

  const balance = useQuery({
    queryKey: keys.balance(accountId, null),
    queryFn: () => apiFetch<BalanceResource>(`/accounts/${accountId}/balance`),
  });

  const postings = useInfiniteQuery({
    queryKey: keys.postings(accountId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiFetch<PostingPageResource>(
        `/accounts/${accountId}/postings${pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`}`,
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const items = (postings.data?.pages ?? []).flatMap((page) => page.items);

  return (
    <main className="mx-auto mt-8 w-[52rem]">
      <h1 className="text-2xl font-semibold">Account</h1>

      <p className="mt-2 text-sm">
        Balance: <span className="font-semibold">{balance.data?.balance ?? '—'}</span>{' '}
        {balance.data?.currency ?? ''}
      </p>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">Date</th>
            <th className="text-left">Description</th>
            <th className="text-right">Amount</th>
            <th className="text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.occurredAt.slice(0, 10)}</td>
              <td>
                <Link to={`/entries/${item.entryId}/reverse`} className="underline">
                  {item.description}
                </Link>
              </td>
              <td className="text-right">{item.amount}</td>
              <td className="text-right">{item.runningBalance}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {postings.hasNextPage ? (
        <button
          type="button"
          onClick={() => { void postings.fetchNextPage(); }}
          disabled={postings.isFetchingNextPage}
          className="mt-4 border p-2 text-sm"
        >
          Load more
        </button>
      ) : null}
    </main>
  );
}
```

Add the route `/accounts/:accountId` to `App.tsx`.

- [ ] **Step 4: Run the tests, typecheck, lint, commit**

```bash
pnpm --filter @ledger/web test
```

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): an account's postings, paged by cursor, with the server's running balance"
```

---

### Task 7: The trial balance

**Files:**
- Create: `apps/web/src/reports/TrialBalance.tsx`
- Create: `apps/web/tests/reports/TrialBalance.test.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `keys.trialBalance`, `TrialBalanceResource`.
- Produces: `<TrialBalance />` at `/books/:bookId/trial-balance`, with `asOf` in the query string.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/reports/TrialBalance.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { TRIAL_BALANCE, USER } from '../msw/handlers';

async function openReport(search = '') {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
  window.history.replaceState(null, '', `/books/book-1/trial-balance${search}`);
  render(<App />);
  return screen.findByRole('heading', { name: /trial balance/i });
}

describe('the trial balance', () => {
  it('groups accounts under a heading per type, in the order the server sent them', async () => {
    await openReport();

    expect(await screen.findByText(/asset/i)).toBeInTheDocument();
    expect(screen.getByText(/revenue/i)).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  it('shows debits and credits per currency', async () => {
    await openReport();

    expect(await screen.findByText('EUR')).toBeInTheDocument();
    expect(screen.getAllByText('10.00').length).toBeGreaterThan(0);
  });

  it('passes asOf from the query string to the API', async () => {
    let requested: string | null = null;
    server.use(
      http.get('/books/:bookId/trial-balance', ({ request }) => {
        requested = new URL(request.url).searchParams.get('asOf');
        return HttpResponse.json(TRIAL_BALANCE);
      }),
    );

    await openReport('?asOf=2026-03-01T00:00:00.000Z');
    await screen.findByText('Cash');

    expect(requested).toBe('2026-03-01T00:00:00.000Z');
  });

  it('renders an unbalanced book as a failure, not a cell', async () => {
    server.use(
      http.get('/books/:bookId/trial-balance', () =>
        HttpResponse.json({
          ...TRIAL_BALANCE,
          totals: [{ currency: 'EUR', debits: '10.00', credits: '9.00', balanced: false }],
          balanced: false,
        }),
      ),
    );

    await openReport();

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not balance/i);
  });
});
```

- [ ] **Step 2: Write the screen**

Create `apps/web/src/reports/TrialBalance.tsx`. Accounts stay in the server's order — by type, then name — and headings are inserted while walking the list, which is what `serialize.ts` says that ordering is for.

```tsx
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import type { TrialBalanceResource } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';

export function TrialBalance() {
  const { bookId = '' } = useParams();
  const [search] = useSearchParams();
  const asOf = search.get('asOf');

  const report = useQuery({
    queryKey: keys.trialBalance(bookId, asOf),
    queryFn: () =>
      apiFetch<TrialBalanceResource>(
        `/books/${bookId}/trial-balance${asOf === null ? '' : `?asOf=${encodeURIComponent(asOf)}`}`,
      ),
  });

  const lines = report.data?.accounts ?? [];

  return (
    <main className="mx-auto mt-8 w-[44rem]">
      <h1 className="text-2xl font-semibold">Trial balance</h1>
      {asOf === null ? null : <p className="text-sm text-gray-600">as of {asOf}</p>}

      {report.data?.balanced === false ? (
        <p role="alert" className="mt-4 border border-red-400 p-3">
          This book does not balance. Every entry sums to zero by construction, so this means
          something has written to the database outside the ledger.
        </p>
      ) : null}

      <table className="mt-6 w-full text-sm">
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.accountId}>
              <td>
                {index === 0 || lines[index - 1]?.type !== line.type ? (
                  <span className="block pt-3 font-semibold uppercase">{line.type}</span>
                ) : null}
                {line.name}
              </td>
              <td className="text-right">{line.balance}</td>
              <td className="text-right text-gray-500">{line.currency}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">Currency</th>
            <th className="text-right">Debits</th>
            <th className="text-right">Credits</th>
          </tr>
        </thead>
        <tbody>
          {(report.data?.totals ?? []).map((total) => (
            <tr key={total.currency}>
              <td>{total.currency}</td>
              <td className="text-right">{total.debits}</td>
              <td className="text-right">{total.credits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

Add the route to `App.tsx`.

- [ ] **Step 3: Run the tests, typecheck, lint, commit**

```bash
pnpm --filter @ledger/web test
```

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): the trial balance, and a loud answer when a book does not"
```

---

### Task 8: The reversal flow

**Files:**
- Create: `apps/web/src/entries/Reversal.tsx`, `apps/web/src/entries/impact.ts`
- Create: `apps/web/tests/entries/impact.test.ts`, `apps/web/tests/entries/Reversal.test.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/tests/msw/handlers.ts`

**Interfaces:**
- Consumes: `apiFetch`, `newIdempotencyKey`, `keys.entry`, `keys.trialBalance`, `EntryResource`, `TrialBalanceResource`.
- Produces: `impactOf(entry, balancesById): { accountId: string; before: Money; delta: Money; after: Money }[]`; `<Reversal />` at `/entries/:entryId/reverse`.

- [ ] **Step 1: Add the entry fixture and handler**

```ts
export const ENTRY: EntryResource = {
  id: 'entry-1',
  bookId: 'book-1',
  occurredAt: '2026-03-01T12:00:00.000Z',
  recordedAt: '2026-03-01T12:00:00.000Z',
  description: 'a sale',
  externalId: null,
  reversalOf: null,
  reversedBy: null,
  postings: [
    { id: '1', accountId: 'acc-cash', amount: '10.00', currency: 'EUR' },
    { id: '2', accountId: 'acc-sales', amount: '-10.00', currency: 'EUR' },
  ],
};
```

```ts
  http.get('/entries/:entryId', () => HttpResponse.json(ENTRY)),
```

- [ ] **Step 2: Write the failing test for the pure part**

Create `apps/web/tests/entries/impact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatMoney, money, type EntryResource } from '@ledger/shared';
import { impactOf } from '../../src/entries/impact';

const entry: EntryResource = {
  id: 'entry-1',
  bookId: 'book-1',
  occurredAt: '2026-03-01T12:00:00.000Z',
  recordedAt: '2026-03-01T12:00:00.000Z',
  description: 'a sale',
  externalId: null,
  reversalOf: null,
  reversedBy: null,
  postings: [
    { id: '1', accountId: 'acc-cash', amount: '10.00', currency: 'EUR' },
    { id: '2', accountId: 'acc-sales', amount: '-10.00', currency: 'EUR' },
  ],
};

describe('impactOf', () => {
  it('negates each leg and applies it to the current balance', () => {
    const balances = new Map([
      ['acc-cash', money(120000n, 'EUR')],
      ['acc-sales', money(-5000n, 'EUR')],
    ]);

    const impact = impactOf(entry, balances);

    expect(impact.map((line) => [line.accountId, formatMoney(line.before), formatMoney(line.delta), formatMoney(line.after)])).toEqual([
      ['acc-cash', '1200.00', '-10.00', '1190.00'],
      ['acc-sales', '-50.00', '10.00', '-40.00'],
    ]);
  });

  it('treats an account with no reported balance as zero', () => {
    const impact = impactOf(entry, new Map());

    expect(formatMoney(impact[0]!.after)).toBe('-10.00');
  });
});
```

- [ ] **Step 3: Write `impact.ts`**

```ts
import { addMoney, negateMoney, parseMoney, zero, type EntryResource, type Money } from '@ledger/shared';

/**
 * What a reversal would do to each account it touches.
 *
 * The arithmetic is certain: a reversal posts the negation of every leg, so the delta is exactly
 * `-leg`. What it cannot promise is acceptance. Reversals are not exempt from the overdraft
 * rule - an entry that cannot be reversed without leaving a guarded account negative is one
 * whose reversal alone is not the correction - and the rule is evaluated at commit, over every
 * prefix of the account's history, which another writer may have moved since this was drawn.
 */
export function impactOf(
  entry: EntryResource,
  balancesById: ReadonlyMap<string, Money>,
): { accountId: string; before: Money; delta: Money; after: Money }[] {
  return entry.postings.map((posting) => {
    const before = balancesById.get(posting.accountId) ?? zero(posting.currency);
    const delta = negateMoney(parseMoney(posting.amount, posting.currency));

    return { accountId: posting.accountId, before, delta, after: addMoney(before, delta) };
  });
}
```

- [ ] **Step 4: Write the failing screen test**

Create `apps/web/tests/entries/Reversal.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { ENTRY, USER } from '../msw/handlers';

async function openReversal() {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
  window.history.replaceState(null, '', '/entries/entry-1/reverse');
  render(<App />);
  return screen.findByRole('heading', { name: /reverse/i });
}

describe('the reversal flow', () => {
  it('shows before, delta and after for each affected account', async () => {
    await openReversal();

    expect(await screen.findByText('1200.00')).toBeInTheDocument();
    expect(screen.getByText('1190.00')).toBeInTheDocument();
  });

  it('warns when a projected balance goes negative, without promising a refusal', async () => {
    server.use(
      http.get('/books/:bookId/trial-balance', () =>
        HttpResponse.json({
          bookId: 'book-1',
          asOf: null,
          accounts: [{ accountId: 'acc-cash', name: 'Cash', type: 'asset', currency: 'EUR', balance: '5.00' }],
          totals: [{ currency: 'EUR', debits: '5.00', credits: '5.00', balanced: true }],
          balanced: true,
        }),
      ),
    );

    await openReversal();

    expect(await screen.findByText(/may refuse/i)).toBeInTheDocument();
  });

  it('refuses to offer a reversal for an entry already reversed', async () => {
    server.use(
      http.get('/entries/:entryId', () => HttpResponse.json({ ...ENTRY, reversedBy: 'entry-2' })),
    );

    await openReversal();

    expect(await screen.findByText(/already reversed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reverse this entry/i })).not.toBeInTheDocument();
  });

  it('posts the reversal with an idempotency key', async () => {
    let key: string | null = null;
    server.use(
      http.post('/entries/:entryId/reverse', ({ request }) => {
        key = request.headers.get('idempotency-key');
        return HttpResponse.json({ id: 'entry-2' }, { status: 201 });
      }),
    );

    await openReversal();
    await userEvent.click(await screen.findByRole('button', { name: /reverse this entry/i }));

    await screen.findByText(/reversed/i);
    expect(key).not.toBeNull();
  });

  it('surfaces an overdraft refusal with the account and the shortfall', async () => {
    server.use(
      http.post('/entries/:entryId/reverse', () =>
        HttpResponse.json(
          {
            status: 422,
            code: 'ACCOUNT_OVERDRAWN',
            detail: 'account acc-cash would be overdrawn',
            requestId: 'req-rev',
            accountId: 'acc-cash',
            shortfall: { currency: 'EUR', amount: '5.00' },
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    await openReversal();
    await userEvent.click(await screen.findByRole('button', { name: /reverse this entry/i }));

    expect(await screen.findByText(/would be overdrawn/i)).toBeInTheDocument();
    expect(screen.getByText('req-rev')).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Write the screen**

Create `apps/web/src/entries/Reversal.tsx`. It reads the entry, reads the book's trial balance for current balances — one request regardless of how many legs the entry has, rather than one balance call per account — computes the impact with `impactOf`, and posts on confirmation.

The entry carries `bookId`, so the trial-balance query is enabled only once the entry has loaded. A projected negative renders as "the server may refuse this" rather than a prediction: the preview owns the arithmetic and does not own the outcome.

```tsx
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import {
  formatMoney,
  isNegativeMoney,
  parseMoney,
  type EntryResource,
  type Money,
  type TrialBalanceResource,
} from '@ledger/shared';
import { apiFetch, newIdempotencyKey } from '../api/client';
import { keys } from '../api/keys';
import { useToast } from '../toast/ToastProvider';
import { impactOf } from './impact';

export function Reversal() {
  const { entryId = '' } = useParams();
  const { showError } = useToast();
  const [done, setDone] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);

  const entry = useQuery({
    queryKey: keys.entry(entryId),
    queryFn: () => apiFetch<EntryResource>(`/entries/${entryId}`),
  });

  const bookId = entry.data?.bookId;

  const trialBalance = useQuery({
    queryKey: keys.trialBalance(bookId ?? '', null),
    queryFn: () => apiFetch<TrialBalanceResource>(`/books/${bookId ?? ''}/trial-balance`),
    enabled: bookId !== undefined,
  });

  const balancesById = useMemo(() => {
    const entries = (trialBalance.data?.accounts ?? []).map(
      (line) => [line.accountId, parseMoney(line.balance, line.currency)] as const,
    );
    return new Map<string, Money>(entries);
  }, [trialBalance.data]);

  const reverse = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>(`/entries/${entryId}/reverse`, {
        method: 'POST',
        idempotencyKey,
        body: {},
      }),
    onSuccess: () => { setDone(true); },
    onError: showError,
  });

  if (entry.data === undefined) return <main className="p-8">Loading…</main>;

  const impact = impactOf(entry.data, balancesById);
  const wouldGoNegative = impact.some((line) => isNegativeMoney(line.after));

  return (
    <main className="mx-auto mt-8 w-[44rem]">
      <h1 className="text-2xl font-semibold">Reverse this entry</h1>
      <p className="mt-1 text-sm text-gray-600">{entry.data.description}</p>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr>
            <th className="text-left">Account</th>
            <th className="text-right">Before</th>
            <th className="text-right">Change</th>
            <th className="text-right">After</th>
          </tr>
        </thead>
        <tbody>
          {impact.map((line) => (
            <tr key={line.accountId}>
              <td>{line.accountId}</td>
              <td className="text-right">{formatMoney(line.before)}</td>
              <td className="text-right">{formatMoney(line.delta)}</td>
              <td className="text-right">{formatMoney(line.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {wouldGoNegative ? (
        <p className="mt-4 border border-amber-400 p-3 text-sm">
          One of these balances would go negative. If that account is guarded, the server may
          refuse this reversal — and it decides against the book as it stands at that moment,
          which another writer may have moved since this preview was drawn.
        </p>
      ) : null}

      {entry.data.reversedBy !== null ? (
        <p className="mt-4 text-sm">This entry has already been reversed.</p>
      ) : done ? (
        <p className="mt-4 text-sm">Entry reversed.</p>
      ) : (
        <button
          type="button"
          onClick={() => { reverse.mutate(); }}
          disabled={reverse.isPending}
          className="mt-4 border p-2"
        >
          Reverse this entry
        </button>
      )}
    </main>
  );
}
```

Add the route to `App.tsx`.

- [ ] **Step 6: Run the tests, typecheck, lint, commit**

```bash
pnpm --filter @ledger/web test
```

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): what a reversal would do, and the one thing it cannot promise"
```

---

### Task 9: One path through the real thing

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/ledger.spec.ts`
- Modify: `apps/web/package.json`, `README.md`

**Interfaces:**
- Consumes: the running API and web dev server.
- Produces: `pnpm --filter @ledger/web e2e`.

Every test written so far mocks transport. What none of them can cover is the wiring this stage's design turns on: the proxy forwarding paths verbatim, the refresh cookie's `Path=/auth`, and the silent refresh at boot. One path exercises all three.

**On the database.** The spec said Testcontainers. Use the compose database instead — `pnpm db:up` and `pnpm db:migrate` — and say why in the config's comment: Testcontainers works when the test process owns the connection, and here the database belongs to a long-lived API process the browser talks to over a socket. Compose provisions the same Postgres 16 from the same `docker/initdb` bootstrap, so it is the same database, obtained the way a developer running the app obtains it.

- [ ] **Step 1: Install Playwright**

```bash
pnpm --filter @ledger/web add -DE @playwright/test
```

```bash
pnpm --filter @ledger/web exec playwright install chromium
```

- [ ] **Step 2: Write the configuration**

Create `apps/web/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

/**
 * One path, through the real thing.
 *
 * Every other test in this package mocks transport, which is the right trade for asserting what
 * a component does. It is the wrong trade for the three things this stage's design turns on and
 * no mock can reach: the proxy forwarding API paths verbatim, the refresh cookie's `Path=/auth`
 * surviving that, and the silent refresh at boot restoring a session after a reload.
 *
 * The database comes from docker compose rather than Testcontainers. Testcontainers works when
 * the test process owns the connection; here it belongs to a long-lived API process the browser
 * talks to over a socket. Compose provisions the same Postgres 16 from the same `docker/initdb`
 * bootstrap - the same database, obtained the way a developer running the app obtains it.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    {
      command: 'pnpm --filter @ledger/api dev',
      url: 'http://localhost:3000/health',
      reuseExistingServer: true,
      cwd: '../..',
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @ledger/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      cwd: '../..',
      timeout: 60_000,
    },
  ],
});
```

- [ ] **Step 3: Write the path**

Create `apps/web/e2e/ledger.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

/**
 * Register, create a book, create two accounts, post a balanced entry, see it in the tree and
 * in the trial balance, reverse it, and watch the balances return.
 *
 * A fresh email per run, because this database is not reset between runs and a ledger cannot
 * delete anything - which is the point of the system, and makes a unique fixture the only
 * isolation available.
 */
const email = () => `e2e-${String(Date.now())}@example.com`;
const PASSWORD = 'a-long-enough-password';

test('a book, an entry, and its reversal', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel(/email/i).fill(email());
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();

  await page.getByLabel(/name/i).fill('E2E book');
  await page.getByLabel(/currency/i).fill('EUR');
  await page.getByRole('button', { name: /create book/i }).click();

  await page.getByRole('link', { name: 'E2E book' }).click();

  for (const [name, type] of [['Cash', 'asset'], ['Sales', 'revenue']] as const) {
    await page.getByLabel(/^name$/i).fill(name);
    await page.getByLabel(/type/i).selectOption(type);
    await page.getByLabel(/currency/i).fill('EUR');
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page.getByRole('link', { name })).toBeVisible();
  }

  // The reload is the assertion here: the access token is held in memory only, so surviving
  // this proves the refresh cookie reached /auth/refresh through the proxy.
  await page.reload();
  await expect(page.getByRole('link', { name: 'Cash' })).toBeVisible();

  await page.goto(new URL(page.url()).pathname.replace('/accounts', '/entries/new'));
  await page.getByLabel(/description/i).fill('a sale');

  const rows = page.getByRole('row');
  await rows.nth(1).getByLabel(/account/i).selectOption({ label: 'Cash (EUR)' });
  await rows.nth(1).getByLabel(/debit/i).fill('10.00');
  await rows.nth(2).getByLabel(/account/i).selectOption({ label: 'Sales (EUR)' });
  await rows.nth(2).getByLabel(/credit/i).fill('10.00');

  await expect(page.getByText(/balanced/i)).toBeVisible();
  await page.getByRole('button', { name: /post entry/i }).click();
  await expect(page.getByText(/entry recorded/i)).toBeVisible();
});
```

- [ ] **Step 4: Add the script and document it**

In `apps/web/package.json`:

```json
    "e2e": "playwright test",
```

In `README.md`, a short paragraph: the end-to-end path needs a database and both servers, so `pnpm db:up && pnpm db:migrate` first, then `pnpm --filter @ledger/web e2e`, which starts the API and the dev server itself. Say what it is for — the proxy, the cookie path, and boot refresh are the parts no mocked test can reach.

- [ ] **Step 5: Run it**

```bash
pnpm db:up
```

```bash
pnpm db:migrate
```

```bash
pnpm --filter @ledger/web e2e
```

Expected: PASS, 1 test. If it fails, do not weaken the assertion — a failure here is the wiring being wrong, which is exactly what this test exists to find. Report it.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

`e2e/` is Playwright's, not Vitest's; confirm `pnpm --filter @ledger/web test` still collects only `tests/**` and does not try to run the spec. If it does, exclude `e2e` in `vite.config.ts`'s `test.include`.

```bash
git add apps/web README.md
git commit -m "test(web): one path through the proxy, the cookie and the boot refresh"
```

---

## Done when

- `pnpm lint`, `pnpm typecheck` and `pnpm -r test` pass from the repository root.
- All five screens the stage names exist and are reachable: the composer at `/books/:bookId/entries/new`, the tree at `/books/:bookId/accounts`, account detail at `/accounts/:accountId`, the trial balance at `/books/:bookId/trial-balance`, and the reversal at `/entries/:entryId/reverse`.
- The composer states its imbalance per currency and refuses to submit until every currency is zero.
- No amount is ever a JS `number`. `grep -rn "parseFloat\|parseInt\|toFixed" apps/web/src` finds nothing, and every `Number(` — if any — is converting something that is not money, such as a row index parsed out of a `legs.3.amount` error path. The rule is about amounts, not about the identifier `Number`.
- Every API call goes through `apiFetch`; every query key comes from `keys`.
- The Playwright path passes against a real API on a real Postgres.

Stage 6 is then complete, and stage 7 — indexes, checkpoints, OpenAPI and CI — begins.
