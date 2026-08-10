# Stage 6, plan 2 — the web scaffold and the shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `apps/web` and everything the five screens sit on: the dev proxy, one HTTP client that owns authentication and idempotency, an in-memory session that survives a reload, login and register, the toast that carries the request id, and a book picker with a create-book empty state.

**Architecture:** React 19 on Vite, same-origin through a Vite proxy that forwards paths verbatim. TanStack Query owns server state; every request goes through one `apiFetch` that attaches the bearer token, mints and holds `Idempotency-Key` across retries, refreshes once on a 401, and turns `problem+json` into a typed `ApiError`. The access token lives in a module variable and nowhere else; the `Path=/auth` refresh cookie is what survives a reload, so boot does one silent refresh. Requests are validated with the Zod schemas from `@ledger/shared`, so the client and the service agree by construction.

**Tech Stack:** React 19, Vite, TanStack Query v5, React Hook Form, Zod 4.4.3, Tailwind, React Router v7, Vitest with jsdom, React Testing Library, MSW.

This is plan 2 of 3 for stage 6. Plan 1 (the shared contract and the three read endpoints) is merged into this branch. Plan 3 is the five screens and the Playwright path. Nothing here builds a ledger screen — this plan ends with a logged-in user looking at their books.

Spec: `docs/superpowers/specs/2026-08-05-stage-6-frontend-design.md`.

## Global Constraints

- Node >= 22, pnpm 11.8.0. Never `npm` or `yarn`.
- **Dependency versions are pinned exactly** — no `^`, no `~`. Always install with `pnpm add -E` (or `-DE`), which writes the resolved exact version. Do not hand-write a version number you have not installed.
- `apps/web` uses `"moduleResolution": "Bundler"`, so **web imports do not carry a `.js` extension** (`./client`, not `./client.js`). This is the opposite of `apps/api` and `packages/shared`, which are `NodeNext` and do require it. Imports of `@ledger/shared` are bare package imports either way.
- `process.env` may be read only in `apps/api/src/config.ts`. In web code, Vite exposes configuration as `import.meta.env`; the ESLint rule does not cover it, and this plan does not introduce any web configuration that needs it.
- Amounts are decimal strings and `bigint` minor units. Never a JS `number` for money, anywhere, including in the browser.
- The access token is never written to `localStorage`, `sessionStorage`, a cookie, or the URL. In memory only.
- No new runtime dependency beyond those named in Task 1 without saying why in the report.
- Before every commit: `pnpm lint`, `pnpm typecheck`, and the tests named in that task's steps must pass.
- Commit messages are conventional and lowercase, in the style already in `git log`. No attribution footer, no co-author trailer, no "Generated with" line.
- Integration tests in `apps/api` need a running Docker daemon. **Nothing in this plan needs one** — every test here runs in jsdom against mocked transport.

## File Structure

**`apps/web/vite.config.ts`** — dev server, the proxy, and the Vitest configuration. One file, because the test environment and the dev server share the same resolve settings.

**`apps/web/src/api/problem.ts`** — `ApiError` and the `problem+json` parser. No network code, so it is testable with a literal.

**`apps/web/src/api/session.ts`** — the in-memory access token, the refresh call, and single-flight coordination. Uses raw `fetch`; must never import `client.ts`, or the refresh path would recurse through the very 401 handler that calls it.

**`apps/web/src/api/client.ts`** — `apiFetch`. Imports `session.ts` and `problem.ts`. The only module in the app that calls `fetch` for the API.

**`apps/web/src/api/keys.ts`** — the TanStack Query key factory. Every key in the app is built here so invalidation is greppable.

**`apps/web/src/session/SessionProvider.tsx`** — boot refresh, current user, login/logout actions, and the route guard.

**`apps/web/src/toast/`** — `ToastRegion.tsx` and the hook that queues toasts.

**`apps/web/src/routes/`** — one file per screen. This plan adds `Login.tsx`, `Register.tsx`, `Books.tsx`.

**`apps/web/src/main.tsx`, `App.tsx`** — the router table and the providers, in that order: query client, session, toasts, router.

**`apps/web/tests/`** — RTL suites and the MSW handlers, mirroring `src/`.

---

### Task 1: Scaffold `apps/web`

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/index.css`
- Create: `apps/web/tests/setup.ts`, `apps/web/tests/App.test.tsx`
- Modify: `eslint.config.js`

**Interfaces:**
- Consumes: nothing.
- Produces: a `@ledger/web` package whose `test`, `typecheck`, `dev` and `build` scripts work, and whose imports of `@ledger/shared` resolve. Later tasks add files under `src/` and `tests/` and touch nothing here except the router table in `App.tsx`.

- [ ] **Step 1: Install the dependencies**

From the repository root. Every command uses exact pinning.

```bash
pnpm --filter @ledger/web add -E react react-dom @tanstack/react-query react-hook-form @hookform/resolvers react-router @ledger/shared@workspace:*
```

```bash
pnpm --filter @ledger/web add -DE vite @vitejs/plugin-react typescript @types/react @types/react-dom tailwindcss @tailwindcss/vite vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom msw eslint-plugin-react-hooks globals
```

Record the resolved versions in your report — later tasks assume these exact ones.

- [ ] **Step 2: Write the package manifest**

Replace the `scripts` block of `apps/web/package.json` (the two stubs that echo "no web tests until stage 6" go away):

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json"
  },
```

- [ ] **Step 3: Write the TypeScript configuration**

Create `apps/web/tsconfig.json`. It cannot simply extend the base: the base targets Node, and a browser app needs the DOM libs, JSX, and bundler resolution.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["vitest/globals"]
  },
  "include": ["src", "tests", "vite.config.ts"]
}
```

`moduleResolution: "Bundler"` is the reason web imports omit `.js`. Everything else — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` — is inherited and stays on.

- [ ] **Step 4: Write the Vite configuration, including the proxy**

Create `apps/web/vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dev server, the proxy, and the test environment.
 *
 * The proxy forwards each API path *verbatim* - no `/api` prefix, no rewrite. That is not a
 * style preference. The refresh cookie is set with `Path=/auth`, so mounting the API under
 * `/api` would mean the browser never sends the cookie to `/api/auth/refresh`: every session
 * would die at its first refresh, with no error anywhere to say why. Same-origin also keeps
 * the cookie's `sameSite=lax` doing the job it was chosen for.
 *
 * Adding a route to the API means adding its top-level path here. The alternative - proxying
 * everything and letting the dev server serve the SPA only on misses - makes a typo'd client
 * path a confusing proxy 404 instead of a route the router can handle.
 */
const API_PATHS = ['/auth', '/books', '/accounts', '/entries', '/health'];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_PATHS.map((path) => [path, { target: 'http://localhost:3000', changeOrigin: false }]),
    ),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
```

`changeOrigin: false` is fine as is: there is no name-based virtual hosting on the target for a rewritten `Host` header to matter to. It's the unprefixed path, not this setting, that keeps `Path=/auth` matchable.

- [ ] **Step 5: Nothing to do — the API can already be started**

This step originally added a `dev` script to `apps/api`. It is already there, along with `start`
and the `apps/api/src/server.ts` entrypoint they run, carried onto this branch from the stage-7
server-entrypoint work:

```json
    "dev": "node --env-file-if-exists=../../.env --import tsx --watch src/server.ts",
```

Leave all three alone. Do not add a second `dev` script, do not drop the `--watch`, and do not
include `apps/api/package.json` in this task's commit.

- [ ] **Step 6: Write the entry point, the shell, and the stylesheet**

Create `apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ledger</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/web/src/index.css`:

```css
@import 'tailwindcss';
```

Create `apps/web/src/App.tsx`:

```tsx
export function App() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">Ledger</h1>
    </main>
  );
}
```

Create `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (root === null) throw new Error('no #root element: index.html and main.tsx disagree');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 7: Write the test setup and a smoke test**

Create `apps/web/tests/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
```

Create `apps/web/tests/App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

describe('App', () => {
  it('renders the application name', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Ledger' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Run the test and watch it pass**

```bash
pnpm --filter @ledger/web test
```

Expected: PASS, 1 test. If the run fails on JSX or on `document`, the tsconfig or the `environment: 'jsdom'` setting is wrong — fix that rather than the test.

- [ ] **Step 9: Teach ESLint about the browser**

`eslint.config.js` applies `globals.node` to everything, so `document` and `window` are undefined identifiers in web files, and JSX has no rules at all. Add a block after the main rules block, before the file-scoped exemptions:

```js
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
```

with `import reactHooks from 'eslint-plugin-react-hooks';` at the top. `react-hooks/exhaustive-deps` is the rule that pays for this: a stale closure over the session token is exactly the bug it catches.

Also add `apps/web/dist/**` to the `ignores` list if `dist/**` does not already cover it.

- [ ] **Step 10: Verify the whole toolchain**

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm -r test
```

Expected: all clean. `pnpm -r test` now runs three suites — `apps/api`, `packages/shared`, `apps/web` — and no longer echoes a stub for the web.

- [ ] **Step 11: Commit**

```bash
git add apps/web eslint.config.js pnpm-lock.yaml package.json
git commit -m "feat(web): the scaffold, and a proxy that keeps the refresh cookie's path"
```

---

### Task 2: `ApiError` and the problem parser

**Files:**
- Create: `apps/web/src/api/problem.ts`
- Create: `apps/web/tests/api/problem.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class ApiError extends Error` with readonly `status: number`, `code: string`, `requestId: string | null`, `errors: readonly { path: string; message: string }[]`, and `detail: string`; plus `async function toApiError(response: Response): Promise<ApiError>`. Tasks 3, 5, 6 and 7 catch `ApiError` and read exactly these fields.

The API answers every failure as RFC 9457 `application/problem+json` with two extensions: `code`, the domain error code a client switches on, and `requestId`, the id echoed in `X-Request-Id`. Read `apps/api/src/http/problem.ts` before writing this — the document's shape is defined there.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/api/problem.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from '../../src/api/problem';

function problemResponse(body: unknown, status = 422): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

describe('toApiError', () => {
  it('reads the code, the detail and the request id a problem document carries', async () => {
    const error = await toApiError(
      problemResponse({
        type: 'https://ledger.local/problems/account-overdrawn',
        title: 'Account overdrawn',
        status: 422,
        detail: 'account 3f4d would be overdrawn',
        instance: '/books/1/entries',
        code: 'ACCOUNT_OVERDRAWN',
        requestId: 'req-123',
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
    expect(error.code).toBe('ACCOUNT_OVERDRAWN');
    expect(error.detail).toBe('account 3f4d would be overdrawn');
    expect(error.requestId).toBe('req-123');
    expect(error.errors).toEqual([]);
  });

  it('carries field errors through, for a validation failure', async () => {
    const error = await toApiError(
      problemResponse(
        {
          title: 'Validation failed',
          status: 400,
          detail: 'invalid request body',
          code: 'VALIDATION_FAILED',
          requestId: 'req-456',
          errors: [{ path: 'legs.0.amount', message: 'must not be blank' }],
        },
        400,
      ),
    );

    expect(error.errors).toEqual([{ path: 'legs.0.amount', message: 'must not be blank' }]);
  });

  it('survives a response that is not a problem document at all', async () => {
    const error = await toApiError(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    expect(error.status).toBe(502);
    expect(error.code).toBe('UNKNOWN');
    expect(error.requestId).toBeNull();
    expect(error.detail).not.toBe('');
  });

  it('falls back to the X-Request-Id header when the body has no requestId', async () => {
    const response = new Response(JSON.stringify({ status: 500, code: 'INTERNAL_ERROR' }), {
      status: 500,
      headers: { 'content-type': 'application/problem+json', 'x-request-id': 'req-789' },
    });

    const error = await toApiError(response);

    expect(error.requestId).toBe('req-789');
  });

  it('keeps extension members, so a caller can read the overdraft shortfall', async () => {
    const error = await toApiError(
      problemResponse({
        status: 422,
        code: 'ACCOUNT_OVERDRAWN',
        detail: 'overdrawn',
        requestId: 'req-1',
        accountId: 'acc-1',
        shortfall: { currency: 'EUR', amount: '5.00' },
      }),
    );

    expect(error.extensions.accountId).toBe('acc-1');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/api/problem.test.ts
```

Expected: FAIL — cannot resolve `../../src/api/problem`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/api/problem.ts`:

```ts
/**
 * A failed response, as something a component can branch on.
 *
 * The API answers every failure as RFC 9457 `application/problem+json`, with two extensions
 * beyond the RFC: `code`, the domain error code, and `requestId`, the id echoed in
 * `X-Request-Id`. `code` is what a `switch` matches on; `requestId` is what goes in the toast,
 * so a user can read out the one string that finds their failure in the logs.
 *
 * The request id is read from the body first and the header second. The body is where the API
 * puts it deliberately, and reading it there means this works unchanged if the app is ever
 * served cross-origin, where the header would need `Access-Control-Expose-Headers` to be
 * readable at all.
 *
 * Nothing here throws. A 502 from a proxy that has never heard of this API is not a problem
 * document, and an error parser that fails on the ugliest failures is the one that leaves a
 * user with a blank screen.
 */

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly requestId: string | null;
  readonly errors: readonly FieldError[];
  /** Error-specific members - `accountId` and `shortfall` on an overdraft, for instance. */
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(input: {
    status: number;
    code: string;
    detail: string;
    requestId: string | null;
    errors: readonly FieldError[];
    extensions: Readonly<Record<string, unknown>>;
  }) {
    super(input.detail);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
    this.requestId = input.requestId;
    this.errors = input.errors;
    this.extensions = input.extensions;
  }
}

export async function toApiError(response: Response): Promise<ApiError> {
  const document = await readJson(response);
  const headerId = response.headers.get('x-request-id');

  if (document === null) {
    return new ApiError({
      status: response.status,
      code: 'UNKNOWN',
      detail: `the server answered ${String(response.status)} with no problem document`,
      requestId: headerId,
      errors: [],
      extensions: {},
    });
  }

  const { code, detail, requestId, errors, ...extensions } = document;

  return new ApiError({
    status: response.status,
    code: typeof code === 'string' ? code : 'UNKNOWN',
    detail: typeof detail === 'string' ? detail : `the server answered ${String(response.status)}`,
    requestId: typeof requestId === 'string' ? requestId : headerId,
    errors: fieldErrorsOf(errors),
    extensions,
  });
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fieldErrorsOf(value: unknown): readonly FieldError[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { path, message } = entry as { path?: unknown; message?: unknown };
    if (typeof path !== 'string' || typeof message !== 'string') return [];
    return [{ path, message }];
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm --filter @ledger/web test -- tests/api/problem.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): a failed response, as something a component can branch on"
```

---

### Task 3: The session token and single-flight refresh

**Files:**
- Create: `apps/web/src/api/session.ts`
- Create: `apps/web/tests/api/session.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `toApiError` from Task 2.
- Produces: `setAccessToken(token: string | null): void`, `getAccessToken(): string | null`, `getSessionUser(): { id: string; email: string } | null`, `refreshSession(): Promise<string | null>`, `onSessionLost(listener: () => void): () => void`. Task 6's provider calls `refreshSession` at boot, reads the identity with `getSessionUser`, and subscribes with `onSessionLost`.

`refreshSession` records the user as well as the token because `POST /auth/refresh` returns both in one body. Discarding the user here would force the caller to make a second identical call to learn who it just refreshed.

This module must never import `client.ts`. `apiFetch` calls `refreshSession` when it sees a 401, so a refresh that went back through `apiFetch` would recurse through its own 401 handler.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/api/session.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAccessToken,
  getSessionUser,
  onSessionLost,
  refreshSession,
  setAccessToken,
} from '../../src/api/session';

function sessionResponse(accessToken: string): Response {
  return new Response(
    JSON.stringify({
      accessToken,
      tokenType: 'Bearer',
      expiresAt: '2026-08-05T12:10:00.000Z',
      user: { id: 'user-1', email: 'someone@example.com' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  setAccessToken(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the access token', () => {
  it('is held in memory and never written to storage', () => {
    setAccessToken('token-1');

    expect(getAccessToken()).toBe('token-1');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});

describe('refreshSession', () => {
  it('posts to /auth/refresh with credentials and stores the new token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse('token-2'));

    const token = await refreshSession();

    expect(token).toBe('token-2');
    expect(getAccessToken()).toBe('token-2');

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('/auth/refresh');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
  });

  it('runs one request when called concurrently, and gives both callers the same token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse('token-3'));

    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);

    expect(first).toBe('token-3');
    expect(second).toBe('token-3');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the token and notifies listeners when the refresh is refused', async () => {
    setAccessToken('stale');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'UNAUTHENTICATED', status: 401 }), {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      }),
    );

    const lost = vi.fn();
    onSessionLost(lost);

    const token = await refreshSession();

    expect(token).toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('records the user the refresh answered with', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sessionResponse('token-4'));

    await refreshSession();

    expect(getSessionUser()).toEqual({ id: 'user-1', email: 'someone@example.com' });
  });

  it('clears the recorded user when the refresh is refused', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sessionResponse('token-5'));
    await refreshSession();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    await refreshSession();

    expect(getSessionUser()).toBeNull();
  });

  it('treats a network failure as a lost session rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(refreshSession()).resolves.toBeNull();
  });

  it('stops notifying a listener that unsubscribed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));

    const lost = vi.fn();
    onSessionLost(lost)();

    await refreshSession();

    expect(lost).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/api/session.test.ts
```

Expected: FAIL — cannot resolve `../../src/api/session`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/api/session.ts`:

```ts
/**
 * The access token, and the one call that renews it.
 *
 * The token lives in a module variable and nowhere else. `apps/api/src/http/cookies.ts`
 * already makes the argument for the refresh token: a credential a script can read is a
 * credential an XSS takes, which is why that one is `httpOnly`. Putting the access token in
 * `localStorage` would hand back exactly what that decision bought - so it is held here, and
 * a page reload starts with no token at all. The refresh cookie survives the reload, so boot
 * calls `refreshSession` once and the session comes back without the user seeing a login form.
 *
 * The refresh is single-flight. Several queries can fail with a 401 in the same tick, and
 * refresh *rotates* the token: the second request to arrive would present a cookie the first
 * has already redeemed, which the API treats as reuse - and reuse revokes the entire token
 * family. Concurrent callers therefore share one in-flight promise, and the second caller
 * getting the first caller's token is the correct outcome, not a shortcut.
 *
 * This module must not import the API client. The client calls `refreshSession` when it sees
 * a 401; a refresh routed back through the client would recurse through its own 401 handler.
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string;
}

let accessToken: string | null = null;
let currentUser: SessionUser | null = null;
let inFlight: Promise<string | null> | null = null;

const listeners = new Set<() => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * Whoever the last refresh answered with.
 *
 * `POST /auth/refresh` returns the user alongside the token, so recording it here costs
 * nothing and saves the boot path an identical second call to learn who it just refreshed.
 */
export function getSessionUser(): SessionUser | null {
  return currentUser;
}

/** Called when the refresh cookie is dead: expired, rotated away, or revoked with its family. */
export function onSessionLost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function refreshSession(): Promise<string | null> {
  inFlight ??= runRefresh().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

async function runRefresh(): Promise<string | null> {
  try {
    const response = await fetch('/auth/refresh', {
      method: 'POST',
      // The refresh cookie is the credential. Same-origin through the dev proxy, but stated
      // explicitly so this does not depend on a default that varies by browser.
      credentials: 'include',
      headers: { accept: 'application/json' },
    });

    if (!response.ok) return loseSession();

    const body: unknown = await response.json();
    const { accessToken: token, user } = body as { accessToken?: unknown; user?: unknown };

    if (typeof token !== 'string') return loseSession();

    accessToken = token;
    currentUser = sessionUserOf(user);
    return token;
  } catch {
    // A network failure is indistinguishable from a dead cookie from here, and treating it as
    // a thrown error would make every caller handle it. The user is signed out; if the
    // network was the cause, signing in again is what they were going to do anyway.
    return loseSession();
  }
}

function loseSession(): null {
  accessToken = null;
  currentUser = null;
  for (const listener of listeners) listener();
  return null;
}

function sessionUserOf(value: unknown): SessionUser | null {
  if (typeof value !== 'object' || value === null) return null;

  const { id, email } = value as { id?: unknown; email?: unknown };
  return typeof id === 'string' && typeof email === 'string' ? { id, email } : null;
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm --filter @ledger/web test -- tests/api/session.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): the token in memory, and one refresh however many callers ask"
```

---

### Task 4: `apiFetch`

**Files:**
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/tests/api/client.test.ts`

**Interfaces:**
- Consumes: `ApiError`, `toApiError` from Task 2; `getAccessToken`, `refreshSession` from Task 3.
- Produces: `apiFetch<T>(path: string, options?: RequestOptions): Promise<T>` where `RequestOptions` is `{ method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string; signal?: AbortSignal }`, and `newIdempotencyKey(): string`. Every later task reaches the API through `apiFetch` and nothing else.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/api/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, newIdempotencyKey } from '../../src/api/client';
import { ApiError } from '../../src/api/problem';
import { setAccessToken } from '../../src/api/session';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(code: string, status: number): Response {
  return new Response(JSON.stringify({ code, status, detail: code, requestId: 'req-1' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

function headersOf(call: [string | URL | Request, RequestInit | undefined] | undefined): Headers {
  return new Headers(call?.[1]?.headers);
}

beforeEach(() => {
  setAccessToken(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiFetch', () => {
  it('returns the parsed body of a successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([{ id: 'book-1' }]));

    await expect(apiFetch('/books')).resolves.toEqual([{ id: 'book-1' }]);
  });

  it('attaches the bearer token when there is one, and no header when there is not', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}));

    await apiFetch('/books');
    expect(headersOf(fetchSpy.mock.calls[0]).has('authorization')).toBe(false);

    setAccessToken('token-1');
    await apiFetch('/books');
    expect(headersOf(fetchSpy.mock.calls[1]).get('authorization')).toBe('Bearer token-1');
  });

  it('sends a JSON body on a POST and sets the content type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ id: 'book-1' }, 201));

    await apiFetch('/books', { method: 'POST', body: { name: 'Test book' } });

    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ name: 'Test book' }));
    expect(headersOf(fetchSpy.mock.calls[0]).get('content-type')).toBe('application/json');
  });

  it('sends the idempotency key it was given, and none when it was given none', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, 201));

    await apiFetch('/books/1/entries', { method: 'POST', body: {}, idempotencyKey: 'key-1' });
    expect(headersOf(fetchSpy.mock.calls[0]).get('idempotency-key')).toBe('key-1');

    await apiFetch('/books', { method: 'POST', body: {} });
    expect(headersOf(fetchSpy.mock.calls[1]).has('idempotency-key')).toBe(false);
  });

  it('returns undefined for a 204, rather than failing to parse an empty body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiFetch('/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('throws an ApiError carrying the code and the request id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem('ACCOUNT_OVERDRAWN', 422));

    const error = await apiFetch('/books/1/entries', { method: 'POST', body: {} }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('ACCOUNT_OVERDRAWN');
    expect((error as ApiError).requestId).toBe('req-1');
  });

  it('refreshes once on a 401 and replays the original request with the new token', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401))
      .mockResolvedValueOnce(
        json({ accessToken: 'token-2', user: { id: 'u', email: 'e@example.com' } }),
      )
      .mockResolvedValueOnce(json([{ id: 'book-1' }]));

    setAccessToken('token-1');

    await expect(apiFetch('/books')).resolves.toEqual([{ id: 'book-1' }]);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('/auth/refresh');
    expect(headersOf(fetchSpy.mock.calls[2]).get('authorization')).toBe('Bearer token-2');
  });

  it('replays a POST with the same idempotency key, so a retry is a retry', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401))
      .mockResolvedValueOnce(json({ accessToken: 'token-2' }))
      .mockResolvedValueOnce(json({ id: 'entry-1' }, 201));

    await apiFetch('/books/1/entries', { method: 'POST', body: {}, idempotencyKey: 'key-9' });

    expect(headersOf(fetchSpy.mock.calls[0]).get('idempotency-key')).toBe('key-9');
    expect(headersOf(fetchSpy.mock.calls[2]).get('idempotency-key')).toBe('key-9');
  });

  it('gives up after one refresh: a second 401 is thrown, not retried again', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401))
      .mockResolvedValueOnce(json({ accessToken: 'token-2' }))
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401));

    await expect(apiFetch('/books')).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry when the refresh itself fails', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401))
      .mockResolvedValueOnce(problem('UNAUTHENTICATED', 401));

    await expect(apiFetch('/books')).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not refresh on any other 4xx', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(problem('FORBIDDEN', 403));

    await expect(apiFetch('/books/1/accounts')).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('newIdempotencyKey', () => {
  it('returns a fresh value each call', () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/api/client.test.ts
```

Expected: FAIL — cannot resolve `../../src/api/client`.

- [ ] **Step 3: Write the module**

Create `apps/web/src/api/client.ts`:

```ts
import { toApiError } from './problem';
import { getAccessToken, refreshSession } from './session';

/**
 * The only place in the application that talks to the API.
 *
 * One function rather than a hook, so it can be called from a query, a mutation, a loader or a
 * test with no React involved. It owns three things that must not be reimplemented per call
 * site:
 *
 *   the credential   the bearer token, read at call time rather than captured, so a refresh
 *                    that lands mid-flight is picked up by the retry rather than by the next
 *                    component render.
 *   the retry        one refresh, one replay, and never again. A second 401 after a successful
 *                    refresh is a real answer - the caller may not do that thing - and
 *                    retrying it would be a loop.
 *   the key          `Idempotency-Key` passes through unchanged on the replay. A retry that
 *                    mints a new key is not a retry, it is a second request, which is the
 *                    exact failure the header exists to prevent.
 */

export interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  /** Book-scoped POSTs only; the API rejects the header where it cannot honour it. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);

  if (response.status === 401) {
    const token = await refreshSession();
    if (token === null) throw await toApiError(response);

    const replay = await send(path, options);
    if (!replay.ok) throw await toApiError(replay);
    return readBody<T>(replay);
  }

  if (!response.ok) throw await toApiError(response);
  return readBody<T>(response);
}

function send(path: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ accept: 'application/json' });

  const token = getAccessToken();
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.idempotencyKey !== undefined) {
    headers.set('idempotency-key', options.idempotencyKey);
  }

  return fetch(path, {
    method,
    headers,
    credentials: 'include',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function readBody<T>(response: Response): Promise<T> {
  // 204 on logout, and nothing else in this API answers with an empty body. `json()` on one
  // throws, which would turn a successful call into a failure.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm --filter @ledger/web test -- tests/api/client.test.ts
```

Expected: PASS, 12 tests. If the single-flight test from Task 3 now fails, the two suites are sharing module state — add `setAccessToken(null)` to this file's `beforeEach`, which the test above already does.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): one client, and a retry that stays the same request"
```

---

### Task 5: The toast region

**Files:**
- Create: `apps/web/src/toast/ToastProvider.tsx`
- Create: `apps/web/tests/toast/ToastProvider.test.tsx`

**Interfaces:**
- Consumes: `ApiError` from Task 2.
- Produces: `<ToastProvider>` (a context provider that renders the region), and `useToast(): { showError(error: unknown): void; dismiss(id: string): void }`. Tasks 6 and 7 call `showError` from mutation error handlers; plan 3 does the same from every screen.

The stage's stated requirement: a user-visible failure carries the `X-Request-Id`, so it is greppable in the structured logs.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/toast/ToastProvider.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/problem';
import { ToastProvider, useToast } from '../../src/toast/ToastProvider';

function Thrower({ error }: { error: unknown }) {
  const { showError } = useToast();
  return (
    <button type="button" onClick={() => { showError(error); }}>
      fail
    </button>
  );
}

function renderWith(error: unknown) {
  return render(
    <ToastProvider>
      <Thrower error={error} />
    </ToastProvider>,
  );
}

function apiError(overrides: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) {
  return new ApiError({
    status: 422,
    code: 'ACCOUNT_OVERDRAWN',
    detail: 'account would be overdrawn',
    requestId: 'req-abc',
    errors: [],
    extensions: {},
    ...overrides,
  });
}

describe('ToastProvider', () => {
  it('shows the detail and the request id of a failure', async () => {
    renderWith(apiError());
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(screen.getByText('account would be overdrawn')).toBeInTheDocument();
    expect(screen.getByText('req-abc')).toBeInTheDocument();
  });

  it('announces toasts in a live region, so a screen reader hears the failure', async () => {
    renderWith(apiError());
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(screen.getByRole('status')).toHaveTextContent('account would be overdrawn');
  });

  it('says there is no request id rather than showing an empty one', async () => {
    renderWith(apiError({ requestId: null, code: 'UNKNOWN', detail: 'the network failed' }));
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(screen.queryByRole('button', { name: /copy request id/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no request id/i)).toBeInTheDocument();
  });

  it('copies the request id to the clipboard', async () => {
    const user = userEvent.setup();
    renderWith(apiError());
    await user.click(screen.getByRole('button', { name: 'fail' }));
    await user.click(screen.getByRole('button', { name: /copy request id/i }));

    await expect(window.navigator.clipboard.readText()).resolves.toBe('req-abc');
  });

  it('dismisses one toast without dismissing the others', async () => {
    const user = userEvent.setup();
    renderWith(apiError());

    await user.click(screen.getByRole('button', { name: 'fail' }));
    await user.click(screen.getByRole('button', { name: 'fail' }));
    expect(screen.getAllByText('account would be overdrawn')).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: /dismiss/i })[0]!);
    expect(screen.getAllByText('account would be overdrawn')).toHaveLength(1);
  });

  it('shows something useful for a thrown value that is not an ApiError', async () => {
    renderWith(new TypeError('Failed to fetch'));
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(screen.getByRole('status')).toHaveTextContent(/failed to fetch/i);
  });
});
```

`userEvent.setup()` installs a clipboard stub, which is why the copy test uses it and the simpler tests do not.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/toast/ToastProvider.test.tsx
```

Expected: FAIL — cannot resolve the provider.

- [ ] **Step 3: Write the provider**

Create `apps/web/src/toast/ToastProvider.tsx`:

```tsx
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../api/problem';

/**
 * Failures, said out loud, with the one string that finds them in the logs.
 *
 * Every problem document the API returns carries `requestId`, and this is where it surfaces:
 * a user reads it out, and it locates their exact failure in the structured logs. A failure
 * with no response at all - the network, not the server - says so, rather than rendering an
 * empty field, because a blank id reads as an answer.
 *
 * Local rather than a toast library: this is a queue, a timer and an `aria-live` region, and
 * the three of them are smaller than the configuration a library would need.
 */

interface Toast {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly requestId: string | null;
}

interface ToastApi {
  showError(error: unknown): void;
  dismiss(id: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = use(ToastContext);
  if (api === null) throw new Error('useToast was called outside a ToastProvider');
  return api;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showError = useCallback((error: unknown) => {
    setToasts((current) => [...current, toastOf(error)]);
  }, []);

  const api = useMemo(() => ({ showError, dismiss }), [showError, dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <div role="status" aria-live="polite" className="fixed bottom-4 right-4 flex flex-col gap-2">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  return (
    <div className="w-96 rounded border border-red-300 bg-white p-3 shadow">
      <p className="font-semibold">{toast.title}</p>
      <p className="text-sm">{toast.detail}</p>

      {toast.requestId === null ? (
        <p className="mt-2 text-xs text-gray-500">No request id: the request never reached the server.</p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <code className="text-xs">{toast.requestId}</code>
          <button
            type="button"
            className="text-xs underline"
            onClick={() => void window.navigator.clipboard.writeText(toast.requestId ?? '')}
          >
            Copy request id
          </button>
        </div>
      )}

      <button
        type="button"
        className="mt-2 text-xs underline"
        onClick={() => { onDismiss(toast.id); }}
      >
        Dismiss
      </button>
    </div>
  );
}

function toastOf(error: unknown): Toast {
  const id = crypto.randomUUID();

  if (error instanceof ApiError) {
    return { id, title: titleOf(error.code), detail: error.detail, requestId: error.requestId };
  }

  return {
    id,
    title: 'Something went wrong',
    detail: error instanceof Error ? error.message : String(error),
    requestId: null,
  };
}

/** `ACCOUNT_OVERDRAWN` reads as "Account overdrawn", which is what a heading should look like. */
function titleOf(code: string): string {
  const words = code.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
pnpm --filter @ledger/web test -- tests/toast/ToastProvider.test.tsx
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): a failure a user can read out, request id and all"
```

---

### Task 6: The session provider, the router, and the auth screens

**Files:**
- Create: `apps/web/src/session/SessionProvider.tsx`
- Create: `apps/web/src/routes/Login.tsx`, `apps/web/src/routes/Register.tsx`
- Create: `apps/web/src/api/keys.ts`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/main.tsx`
- Create: `apps/web/tests/msw/handlers.ts`, `apps/web/tests/msw/server.ts`
- Create: `apps/web/tests/session/auth.test.tsx`
- Modify: `apps/web/tests/setup.ts`, `apps/web/tests/App.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (Task 4), `setAccessToken`/`refreshSession`/`onSessionLost` (Task 3), `useToast` (Task 5), and `credentials` from `@ledger/shared`.
- Produces: `<SessionProvider>`, `useSession(): { user: User | null; status: 'booting' | 'anonymous' | 'signed-in'; signIn(input): Promise<void>; register(input): Promise<void>; signOut(): Promise<void> }` where `User` is `{ id: string; email: string }`; `<RequireSession>` as a route element that renders `<Outlet />` when signed in and redirects to `/login` otherwise; and the query key factory in `keys.ts`. Task 7 consumes `useSession` and `keys.books()`.

- [ ] **Step 1: Stand up MSW**

Create `apps/web/tests/msw/handlers.ts`. These are the default handlers; individual tests override them with `server.use(...)`.

```ts
import { http, HttpResponse } from 'msw';
import type { BookResource } from '@ledger/shared';

export const USER = { id: 'user-1', email: 'owner@example.com' };

export const BOOKS: BookResource[] = [
  {
    id: 'book-1',
    name: 'Test book',
    baseCurrency: 'EUR',
    createdAt: '2026-03-01T12:00:00.000Z',
    role: 'owner',
  },
];

function session() {
  return HttpResponse.json({
    accessToken: 'access-token',
    tokenType: 'Bearer',
    expiresAt: '2026-08-05T12:10:00.000Z',
    user: USER,
  });
}

export const handlers = [
  http.post('/auth/login', () => session()),
  http.post('/auth/register', () => session()),
  // No session by default: a fresh test starts signed out, and a test that wants a session
  // overrides this with `server.use(...)`.
  http.post('/auth/refresh', () =>
    HttpResponse.json(
      { status: 401, code: 'UNAUTHENTICATED', detail: 'no refresh cookie was presented', requestId: 'req-boot' },
      { status: 401, headers: { 'content-type': 'application/problem+json' } },
    ),
  ),
  http.post('/auth/logout', () => new HttpResponse(null, { status: 204 })),
  http.get('/books', () => HttpResponse.json(BOOKS)),
];
```

Create `apps/web/tests/msw/server.ts`:

```ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
```

Extend `apps/web/tests/setup.ts` so every suite gets it:

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './msw/server';
import { setAccessToken } from '../src/api/session';

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  setAccessToken(null);
});

afterAll(() => {
  server.close();
});
```

`onUnhandledRequest: 'error'` is deliberate: a request the handlers do not describe is a request the test did not mean to make.

- [ ] **Step 2: Write the failing test**

Create `apps/web/tests/session/auth.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { USER } from '../msw/handlers';

function signedIn() {
  server.use(
    http.post('/auth/refresh', () =>
      HttpResponse.json({
        accessToken: 'access-token',
        tokenType: 'Bearer',
        expiresAt: '2026-08-05T12:10:00.000Z',
        user: USER,
      }),
    ),
  );
}

describe('booting', () => {
  it('shows the login form when the refresh cookie is dead', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });

  it('restores the session from the refresh cookie without showing a login form', async () => {
    signedIn();
    render(<App />);

    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
  });
});

describe('signing in', () => {
  it('signs in and lands on the books screen', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText(/email/i), 'owner@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(USER.email)).toBeInTheDocument();
  });

  it('refuses to submit a password shorter than the schema allows, without calling the API', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/auth/login', () => {
        throw new Error('the API must not be called for a password the schema rejects');
      }),
    );

    render(<App />);

    await user.type(await screen.findByLabelText(/email/i), 'owner@example.com');
    await user.type(screen.getByLabelText(/password/i), 'short');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
  });

  it('surfaces a rejected credential as a toast carrying the request id', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/auth/login', () =>
        HttpResponse.json(
          {
            status: 401,
            code: 'UNAUTHENTICATED',
            detail: 'email or password is incorrect',
            requestId: 'req-login',
          },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    render(<App />);

    await user.type(await screen.findByLabelText(/email/i), 'owner@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('email or password is incorrect')).toBeInTheDocument();
    expect(screen.getByText('req-login')).toBeInTheDocument();
  });
});

describe('registering', () => {
  it('creates an account and signs in', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('link', { name: /create an account/i }));
    await user.type(screen.getByLabelText(/email/i), 'new@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(USER.email)).toBeInTheDocument();
  });

  it('puts a taken email on the email field rather than in a toast', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/auth/register', () =>
        HttpResponse.json(
          {
            status: 409,
            code: 'EMAIL_ALREADY_REGISTERED',
            detail: 'that email is already registered',
            requestId: 'req-dup',
          },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    render(<App />);

    await user.click(await screen.findByRole('link', { name: /create an account/i }));
    await user.type(screen.getByLabelText(/email/i), 'taken@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/already registered/i)).toBeInTheDocument();
  });
});

describe('signing out', () => {
  it('returns to the login form', async () => {
    const user = userEvent.setup();
    signedIn();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /sign out/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    });
  });
});

```

A session that dies mid-flight is deliberately not tested here: the two halves of it are already
covered — `client.test.ts` proves a 401 with a failing refresh throws rather than looping, and
`session.test.ts` proves the refusal notifies `onSessionLost`. The end-to-end version of it needs
a screen that actually queries on mount, so it belongs in Task 7 with the books screen.

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/session/auth.test.tsx
```

Expected: FAIL — `App` renders only the heading from Task 1, so no form exists.

- [ ] **Step 4: Write the query key factory**

Create `apps/web/src/api/keys.ts`:

```ts
/**
 * Every query key in the application, built here.
 *
 * Keys are what invalidation targets, so a key spelled inline at the call site is an
 * invalidation nobody can grep for. Each is a function even where it takes no argument, so
 * every call site reads the same way.
 */
export const keys = {
  books: () => ['books'] as const,
  accounts: (bookId: string) => ['book', bookId, 'accounts'] as const,
  trialBalance: (bookId: string, asOf: string | null) =>
    ['book', bookId, 'trial-balance', asOf] as const,
  balance: (accountId: string, asOf: string | null) =>
    ['account', accountId, 'balance', asOf] as const,
  postings: (accountId: string) => ['account', accountId, 'postings'] as const,
  entry: (entryId: string) => ['entry', entryId] as const,
};
```

The later three are unused until plan 3 and are here so the factory is one file rather than one per screen.

- [ ] **Step 5: Write the session provider**

Create `apps/web/src/session/SessionProvider.tsx`:

```tsx
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';
import type { CredentialsInput } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { getSessionUser, onSessionLost, refreshSession, setAccessToken } from '../api/session';

/**
 * Who is signed in, and the three calls that change the answer.
 *
 * Boot runs one refresh. The access token does not survive a reload - it is deliberately held
 * in memory only - but the `Path=/auth` cookie does, so a returning user gets their session
 * back without seeing a form. Until that call answers the status is `booting`, which is why
 * the guard renders nothing rather than redirecting: a redirect during boot would bounce every
 * signed-in user to the login screen on every reload.
 */

export interface User {
  readonly id: string;
  readonly email: string;
}

interface SessionResponse {
  readonly accessToken: string;
  readonly user: User;
}

type Status = 'booting' | 'anonymous' | 'signed-in';

interface SessionApi {
  readonly user: User | null;
  readonly status: Status;
  signIn(input: CredentialsInput): Promise<void>;
  register(input: CredentialsInput): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const api = use(SessionContext);
  if (api === null) throw new Error('useSession was called outside a SessionProvider');
  return api;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>('booting');

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      const token = await refreshSession();
      if (cancelled) return;

      if (token === null) {
        setStatus('anonymous');
        return;
      }

      // The identity came back in the same body as the token, so there is no second call.
      setUser(getSessionUser());
      setStatus('signed-in');
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      onSessionLost(() => {
        setUser(null);
        setStatus('anonymous');
      }),
    [],
  );

  const authenticate = useCallback(async (path: '/auth/login' | '/auth/register', input: CredentialsInput) => {
    const session = await apiFetch<SessionResponse>(path, { method: 'POST', body: input });
    setAccessToken(session.accessToken);
    setUser(session.user);
    setStatus('signed-in');
  }, []);

  const signIn = useCallback((input: CredentialsInput) => authenticate('/auth/login', input), [authenticate]);
  const register = useCallback((input: CredentialsInput) => authenticate('/auth/register', input), [authenticate]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      // Whatever the server said, this browser is done with the session. A logout that failed
      // and left the user apparently signed in is worse than one that forgets locally.
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const api = useMemo(
    () => ({ user, status, signIn, register, signOut }),
    [user, status, signIn, register, signOut],
  );

  return <SessionContext value={api}>{children}</SessionContext>;
}

export function RequireSession() {
  const { status } = useSession();

  if (status === 'booting') return null;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return <Outlet />;
}
```


- [ ] **Step 6: Write the auth screens**

Create `apps/web/src/routes/Login.tsx`:

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { credentials, type CredentialsInput } from '@ledger/shared';
import { FieldError } from '../forms/FieldError';
import { useSession } from '../session/SessionProvider';
import { useToast } from '../toast/ToastProvider';

/**
 * The credential rules are not restated here. `credentials` is the same schema
 * `AuthService.login` parses, imported from `@ledger/shared`, so a password this form accepts
 * is a password the service accepts - and the twelve-character minimum has one definition
 * rather than two that drift.
 */
export function Login() {
  const { signIn } = useSession();
  const { showError } = useToast();
  const navigate = useNavigate();

  const form = useForm<CredentialsInput>({ resolver: zodResolver(credentials) });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await signIn(values);
      await navigate('/books');
    } catch (error) {
      showError(error);
    }
  });

  return (
    <main className="mx-auto mt-16 w-80">
      <h1 className="text-2xl font-semibold">Sign in</h1>

      <form onSubmit={(event) => { void onSubmit(event); }} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          Email
          <input type="email" autoComplete="username" {...form.register('email')} className="border p-2" />
        </label>
        <FieldError message={form.formState.errors.email?.message} />

        <label className="flex flex-col gap-1">
          Password
          <input
            type="password"
            autoComplete="current-password"
            {...form.register('password')}
            className="border p-2"
          />
        </label>
        <FieldError message={form.formState.errors.password?.message} />

        <button type="submit" disabled={form.formState.isSubmitting} className="border p-2">
          Sign in
        </button>
      </form>

      <p className="mt-4 text-sm">
        <Link to="/register" className="underline">Create an account</Link>
      </p>
    </main>
  );
}
```

Create `apps/web/src/forms/FieldError.tsx`, which both auth screens and every form in plan 3 use:

```tsx
import { ApiError } from '../api/problem';

export function FieldError({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return <p className="text-sm text-red-700">{message}</p>;
}

/**
 * A failure that belongs on a field rather than in a toast.
 *
 * `EMAIL_ALREADY_REGISTERED` is the case this exists for: it is a fact about the database, so
 * no client-side schema can know it, and it belongs on the email input rather than floating in
 * the corner of the screen away from the field it is about.
 */
export function isCode(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code;
}
```

Create `apps/web/src/routes/Register.tsx`:

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { credentials, type CredentialsInput } from '@ledger/shared';
import { FieldError, isCode } from '../forms/FieldError';
import { useSession } from '../session/SessionProvider';
import { useToast } from '../toast/ToastProvider';

export function Register() {
  const { register: createAccount } = useSession();
  const { showError } = useToast();
  const navigate = useNavigate();

  const form = useForm<CredentialsInput>({ resolver: zodResolver(credentials) });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createAccount(values);
      await navigate('/books');
    } catch (error) {
      // A taken address is a fact about the database, not about the form's shape, so it
      // arrives as a 409 and belongs on the field the user has to change.
      if (isCode(error, 'EMAIL_ALREADY_REGISTERED')) {
        form.setError('email', { message: error.detail });
        return;
      }

      showError(error);
    }
  });

  return (
    <main className="mx-auto mt-16 w-80">
      <h1 className="text-2xl font-semibold">Create an account</h1>

      <form onSubmit={(event) => { void onSubmit(event); }} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          Email
          <input type="email" autoComplete="username" {...form.register('email')} className="border p-2" />
        </label>
        <FieldError message={form.formState.errors.email?.message} />

        <label className="flex flex-col gap-1">
          Password
          <input
            type="password"
            autoComplete="new-password"
            {...form.register('password')}
            className="border p-2"
          />
        </label>
        <FieldError message={form.formState.errors.password?.message} />

        <button type="submit" disabled={form.formState.isSubmitting} className="border p-2">
          Create account
        </button>
      </form>

      <p className="mt-4 text-sm">
        <Link to="/login" className="underline">Sign in instead</Link>
      </p>
    </main>
  );
}
```

`useSession().register` is renamed to `createAccount` at the call site because `form.register` is
already bound in this component, and two things called `register` in one function is how the wrong
one gets called.

- [ ] **Step 7: Wire the router**

Rewrite `apps/web/src/App.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError } from './api/problem';
import { Login } from './routes/Login';
import { Register } from './routes/Register';
import { RequireSession, SessionProvider } from './session/SessionProvider';
import { ToastProvider } from './toast/ToastProvider';

/**
 * Providers, in the order their dependencies run: the query client knows nothing about the
 * others, the session makes API calls, the toasts are what a failed call surfaces through,
 * and the router is what the session's guard redirects inside of.
 *
 * Nothing here is optimistic, and the retry policy is why. A 4xx is an answer - the server
 * considered the request and declined it - and asking again changes nothing except the load.
 * Only a request that never got an answer is worth repeating.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) =>
          !(error instanceof ApiError) && failureCount < 1,
      },
      mutations: { retry: false },
    },
  });
}

export function App() {
  // `useState(fn)` rather than `createQueryClient()` inline: the inline form builds a new
  // client on every render of this component, which would throw the whole cache away the
  // first time anything above it re-renders. The lazy initialiser builds exactly one.
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <SessionProvider>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route element={<RequireSession />}>
                <Route path="/books" element={<Books />} />
              </Route>
              <Route path="*" element={<Navigate to="/books" replace />} />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

`Books` does not exist yet. Define this placeholder in `App.tsx`, and delete it in Task 7 when the
real screen arrives:

```tsx
/** Placeholder. Task 7 replaces this with the real books screen and deletes this component. */
function Books() {
  const { user, signOut } = useSession();

  return (
    <main className="p-8">
      <span>{user?.email}</span>
      <button type="button" onClick={() => { void signOut(); }}>Sign out</button>
    </main>
  );
}
```

Building the client inside `App` means each `render(<App />)` in a test starts with a clean cache,
which is what keeps the suites from leaking data into each other.

Update `apps/web/tests/App.test.tsx`: the old smoke test asserted a heading that no longer exists. Replace it with one asserting that an anonymous boot lands on the login screen — or delete it, since `tests/session/auth.test.tsx` now covers exactly that. Do not leave a test asserting text the app no longer renders.

- [ ] **Step 8: Run the tests and watch them pass**

```bash
pnpm --filter @ledger/web test
```

Expected: PASS, all suites.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
git add apps/web
git commit -m "feat(web): a session that survives a reload, and the two forms that start one"
```

---

### Task 7: The book picker and the create-book empty state

**Files:**
- Create: `apps/web/src/routes/Books.tsx`
- Create: `apps/web/src/books/BookPicker.tsx`
- Create: `apps/web/tests/books/Books.test.tsx`
- Modify: `apps/web/src/App.tsx` (remove the placeholder, route to the real screen)

**Interfaces:**
- Consumes: `apiFetch` (Task 4), `keys` (Task 6), `useSession` (Task 6), `useToast` (Task 5), `BookResource` and `createBookInput` from `@ledger/shared`.
- Produces: `<Books />`, and `useBooks(): UseQueryResult<BookResource[]>`. Plan 3's screens read the selected book from the route parameter, not from here — this screen's job ends at navigating to one.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/books/Books.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { BookResource } from '@ledger/shared';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { BOOKS, USER } from '../msw/handlers';

function signedIn() {
  server.use(
    http.post('/auth/refresh', () =>
      HttpResponse.json({ accessToken: 'access-token', user: USER }),
    ),
  );
}

describe('the books screen', () => {
  it('lists the books the caller can reach, with the role they hold', async () => {
    signedIn();
    render(<App />);

    expect(await screen.findByRole('link', { name: /test book/i })).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
  });

  it('offers a create-book form when the caller has no books at all', async () => {
    signedIn();
    server.use(http.get('/books', () => HttpResponse.json([])));

    render(<App />);

    expect(await screen.findByRole('heading', { name: /create your first book/i })).toBeInTheDocument();
  });

  it('creates a book and shows it in the list without a manual reload', async () => {
    const user = userEvent.setup();
    signedIn();

    const created: BookResource = {
      id: 'book-2',
      name: 'Second book',
      baseCurrency: 'USD',
      createdAt: '2026-03-02T12:00:00.000Z',
      role: 'owner',
    };

    let books: BookResource[] = [];
    server.use(
      http.get('/books', () => HttpResponse.json(books)),
      http.post('/books', () => {
        books = [created];
        return HttpResponse.json(created, { status: 201 });
      }),
    );

    render(<App />);

    await user.type(await screen.findByLabelText(/name/i), 'Second book');
    await user.type(screen.getByLabelText(/currency/i), 'USD');
    await user.click(screen.getByRole('button', { name: /create book/i }));

    expect(await screen.findByRole('link', { name: /second book/i })).toBeInTheDocument();
  });

  it('rejects a currency that is not three uppercase letters, without calling the API', async () => {
    const user = userEvent.setup();
    signedIn();
    server.use(
      http.get('/books', () => HttpResponse.json([])),
      http.post('/books', () => {
        throw new Error('the API must not be called for a currency the schema rejects');
      }),
    );

    render(<App />);

    await user.type(await screen.findByLabelText(/name/i), 'Second book');
    await user.type(screen.getByLabelText(/currency/i), 'usd');
    await user.click(screen.getByRole('button', { name: /create book/i }));

    expect(await screen.findByText(/three-letter ISO 4217 code/i)).toBeInTheDocument();
  });

  it('surfaces a failed creation as a toast with its request id', async () => {
    const user = userEvent.setup();
    signedIn();
    server.use(
      http.get('/books', () => HttpResponse.json([])),
      http.post('/books', () =>
        HttpResponse.json(
          { status: 403, code: 'API_KEY_NOT_PERMITTED', detail: 'creating a book', requestId: 'req-book' },
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    render(<App />);

    await user.type(await screen.findByLabelText(/name/i), 'Second book');
    await user.type(screen.getByLabelText(/currency/i), 'USD');
    await user.click(screen.getByRole('button', { name: /create book/i }));

    expect(await screen.findByText('req-book')).toBeInTheDocument();
  });

  it('does not offer the create form to a caller who already has books', async () => {
    signedIn();
    render(<App />);

    await screen.findByRole('link', { name: /test book/i });
    expect(screen.queryByRole('heading', { name: /create your first book/i })).not.toBeInTheDocument();
  });
});

describe('a session lost mid-flight', () => {
  it('returns to the login form when the books query 401s and the refresh fails too', async () => {
    signedIn();
    server.use(
      http.get('/books', () =>
        HttpResponse.json(
          { status: 401, code: 'UNAUTHENTICATED', detail: 'expired', requestId: 'req-x' },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    render(<App />);

    // The boot refresh succeeds, so the screen mounts and its query runs; that query's 401
    // triggers a second refresh, which the default handler refuses. Nothing here clicks
    // anything - the screen querying on mount is what makes the dead session observable.
    server.use(
      http.post('/auth/refresh', () =>
        HttpResponse.json(
          { status: 401, code: 'UNAUTHENTICATED', detail: 'dead cookie', requestId: 'req-y' },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });
});
```

`BOOKS` is imported for the fixture's name only; if your editor flags it as unused after you write
the tests, drop it from the import rather than adding an assertion about a fixture.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @ledger/web test -- tests/books/Books.test.tsx
```

Expected: FAIL — the placeholder from Task 6 renders no book list.

- [ ] **Step 3: Write the picker**

Create `apps/web/src/books/BookPicker.tsx`:

```tsx
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { createBookInput, type BookResource, type CreateBookInput } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';
import { FieldError } from '../forms/FieldError';
import { useToast } from '../toast/ToastProvider';

export function useBooks() {
  return useQuery({
    queryKey: keys.books(),
    queryFn: () => apiFetch<BookResource[]>('/books'),
  });
}

export function BookList({ books }: { books: readonly BookResource[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-2">
      {books.map((book) => (
        <li key={book.id} className="flex items-center justify-between border p-3">
          <Link to={`/books/${book.id}/accounts`} className="underline">
            {book.name}
          </Link>
          <span className="text-sm text-gray-600">
            {book.baseCurrency} · {book.role}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The role comes from the server, on the book.
 *
 * It is here so the UI can decline to offer what `domain/policy.ts` forbids - a viewer should
 * not be shown a compose button whose only outcome is a 403. The server still decides; this
 * only stops the client asking.
 */
export function CreateBookForm({ heading }: { heading: string }) {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const form = useForm<CreateBookInput>({ resolver: zodResolver(createBookInput) });

  const create = useMutation({
    mutationFn: (input: CreateBookInput) =>
      apiFetch<BookResource>('/books', { method: 'POST', body: input }),
    onSuccess: async () => {
      form.reset();
      await queryClient.invalidateQueries({ queryKey: keys.books() });
    },
    onError: showError,
  });

  const onSubmit = form.handleSubmit((values) => {
    create.mutate(values);
  });

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">{heading}</h2>

      <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          Name
          <input {...form.register('name')} className="border p-2" />
        </label>
        <FieldError message={form.formState.errors.name?.message} />

        <label className="flex flex-col gap-1">
          Base currency
          <input {...form.register('baseCurrency')} className="border p-2" />
        </label>
        <FieldError message={form.formState.errors.baseCurrency?.message} />

        <button type="submit" disabled={create.isPending} className="border p-2">
          Create book
        </button>
      </form>
    </section>
  );
}
```

`POST /books` does not accept an `Idempotency-Key` — the reservation table is keyed on `(book_id, key)` and there is no book to key it on yet, which `registry.ts`'s `acceptsIdempotencyKey` states. That is why no key is minted here.

- [ ] **Step 4: Write the screen**

Create `apps/web/src/routes/Books.tsx`:

```tsx
import { BookList, CreateBookForm, useBooks } from '../books/BookPicker';
import { useSession } from '../session/SessionProvider';

export function Books() {
  const { user, signOut } = useSession();
  const books = useBooks();

  return (
    <main className="mx-auto mt-8 w-[40rem]">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Books</h1>
        <div className="flex items-center gap-3 text-sm">
          <span>{user?.email}</span>
          <button type="button" onClick={() => { void signOut(); }} className="underline">
            Sign out
          </button>
        </div>
      </header>

      {books.isPending ? <p className="mt-4">Loading…</p> : null}

      {books.data !== undefined && books.data.length > 0 ? <BookList books={books.data} /> : null}

      {books.data !== undefined && books.data.length === 0 ? (
        <CreateBookForm heading="Create your first book" />
      ) : null}
    </main>
  );
}
```

Then in `App.tsx`: delete the Task 6 placeholder and its comment, import this `Books`, and keep the route as it was.

- [ ] **Step 5: Run everything**

```bash
pnpm --filter @ledger/web test
```

```bash
pnpm typecheck
```

```bash
pnpm lint
```

Expected: all clean.

- [ ] **Step 6: Update the README**

`README.md`'s Layout block still says `apps/web  stage 6`. Replace that line with a short description of what the web app now is, and add a paragraph to the running-it section covering the two processes development needs — `pnpm --filter @ledger/api dev` and `pnpm --filter @ledger/web dev` — and why the proxy forwards paths verbatim (the `Path=/auth` cookie). Write it in the README's voice: explain the reason, not the steps alone.

- [ ] **Step 7: Commit**

```bash
git add apps/web README.md
git commit -m "feat(web): the books a caller can reach, and a way to have a first one"
```

---

## Done when

- `pnpm lint`, `pnpm typecheck` and `pnpm -r test` all pass from the repository root, with `apps/web` contributing real tests rather than a stub.
- `pnpm --filter @ledger/api dev` and `pnpm --filter @ledger/web dev` together serve a working app at `http://localhost:5173`: register, sign in, create a book, reload the page and stay signed in, sign out.
- The access token appears in no storage, no cookie and no URL.
- Every API call in `apps/web` goes through `apiFetch`; `grep -rn "fetch(" apps/web/src` finds it only in `api/client.ts` and `api/session.ts`.
- A failed request produces a toast carrying its `requestId`, and a failure with no response says there is no request id.

Plan 3 (the entry composer, the account tree, account detail, the trial balance, the reversal flow, and the Playwright path) begins from here.
