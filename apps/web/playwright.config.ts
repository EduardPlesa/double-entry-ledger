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
