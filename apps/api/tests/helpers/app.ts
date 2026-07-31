import { testClock, type TestClock } from '@ledger/shared';
import { pino } from 'pino';
import type { Response } from 'supertest';
import { inject } from 'vitest';
import { createApplication, type Application } from '../../src/composition.js';
import { loadConfig } from '../../src/config.js';
import { REFRESH_COOKIE_NAME } from '../../src/http/cookies.js';

/**
 * The real application, wired to the container database.
 *
 * Nothing is mocked. The clock is substituted so expiry is a value a test can move, and
 * argon2 runs at trivial cost because the production parameters are deliberately slow and
 * this suite hashes on nearly every test. Both go through `loadConfig`, so the configuration
 * a test runs under is validated by the same schema as the configuration a server runs under.
 */

export const START = new Date('2026-03-31T09:00:00.000Z');

const TEST_JWT_SECRET = 'integration-test-jwt-secret-at-least-32-chars';
const TEST_REFRESH_PEPPER = 'integration-test-refresh-pepper-32-chars-min';

export interface TestApplication extends Application {
  readonly clock: TestClock;
}

export function createTestApplication(): TestApplication {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: inject('appUrl'),
    DATABASE_MIGRATION_URL: inject('ownerUrl'),
    AUTH_JWT_SECRET: TEST_JWT_SECRET,
    AUTH_REFRESH_TOKEN_PEPPER: TEST_REFRESH_PEPPER,
    AUTH_ARGON2_MEMORY_COST_KIB: '8',
    AUTH_ARGON2_TIME_COST: '1',
    AUTH_ARGON2_PARALLELISM: '1',
  });

  const clock = testClock(START);

  // Silent, not merely quiet. pino's own levels stop at 'trace', and a passing test that
  // prints a JSON line per request is a test whose output nobody reads.
  const application = createApplication(config, { clock, logger: pino({ level: 'silent' }) });

  return { ...application, clock };
}

/**
 * A unique address per call.
 *
 * This database has no teardown - users cannot be deleted any more than entries can - so
 * tests isolate themselves by never colliding rather than by cleaning up, which is the same
 * thing the running system has to do.
 */
export function uniqueEmail(label = 'user'): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}@example.test`;
}

export const STRONG_PASSWORD = 'a-perfectly-adequate-passphrase';

/** The raw `Set-Cookie` entries for the refresh cookie, attributes and all. */
export function refreshCookieHeader(response: Response): string | undefined {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return cookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
}

/**
 * The cookie's value, ready to be sent back on a later request.
 *
 * Extracted by hand rather than with an agent, because several of these tests need to present
 * a cookie the browser would already have thrown away - a rotated one, most importantly. A
 * cookie jar that helpfully discards it makes the reuse-detection test impossible to write.
 */
export function refreshCookieValue(response: Response): string {
  const cookie = refreshCookieHeader(response);
  if (cookie === undefined) throw new Error('the response set no refresh cookie');

  const value = cookie.split(';')[0]?.split('=')[1];
  if (value === undefined || value === '') throw new Error(`no value in cookie: ${cookie}`);

  return decodeURIComponent(value);
}

/** Formats a token as the `Cookie` header a client would send. */
export function asCookie(token: string): string {
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}`;
}
