import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './msw/server';
import { setAccessToken } from '../src/api/session';

// Two ways of faking the network coexist in this suite, and the split is deliberate rather
// than accidental: `tests/api/client.test.ts` and `tests/api/session.test.ts` spy on
// `globalThis.fetch` directly, because those files *are* the transport layer under test - they
// need to assert on exactly what `fetch` was called with, which MSW's handler abstraction would
// hide. Everything that renders a component goes through MSW instead, because a component test
// cares what the API answered, not how the call was shaped. The fetch-spying files bypass this
// file's `onUnhandledRequest: 'error'` entirely - a mocked `fetch` never reaches MSW's
// interception - which is why they can get away with responses this file's handlers know
// nothing about.

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  setAccessToken(null);
  // `App` mounts a `BrowserRouter`, which reads the real `window.location`. jsdom's window
  // survives across tests in the same file, so a test that navigates - a click, a redirect -
  // would otherwise leave the next test starting from wherever the last one ended, rather
  // than from `/`.
  window.history.replaceState(null, '', '/');
});

afterAll(() => {
  server.close();
});
