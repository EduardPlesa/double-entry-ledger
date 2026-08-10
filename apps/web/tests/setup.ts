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
  // `App` mounts a `BrowserRouter`, which reads the real `window.location`. jsdom's window
  // survives across tests in the same file, so a test that navigates - a click, a redirect -
  // would otherwise leave the next test starting from wherever the last one ended, rather
  // than from `/`.
  window.history.replaceState(null, '', '/');
});

afterAll(() => {
  server.close();
});
