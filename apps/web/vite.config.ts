import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

/**
 * The dev server, the proxy, and the test environment.
 *
 * The proxy forwards each API path *verbatim* - no `/api` prefix, no rewrite. That is not a
 * style preference. The refresh cookie is set with `Path=/auth`, so mounting the API under
 * `/api` would mean the browser never sends the cookie to `/api/auth/refresh`: every session
 * would die at its first refresh, with no error anywhere to say why. Same-origin also keeps
 * the cookie's `sameSite=lax` doing the job it was chosen for.
 *
 * Adding a route to the API means adding its top-level path here. Several of these paths are
 * also routes the SPA's own router owns - `/books` is both the API's collection endpoint and
 * the app's home route and catch-all redirect target - because the client and the API were
 * always going to share a vocabulary for the same resources. That overlap means the proxy
 * cannot simply claim every request under a matched path: a reload at `/books` has to reach
 * `index.html`, not the API. `bypass` is what tells the two apart. A browser navigating to a
 * document - a reload, a typed URL, a link followed outside the SPA - sends
 * `Accept: text/html`; a `fetch` call from `apiFetch` asks for `application/json` and never
 * sets that header. On the `text/html` signal, `bypass` hands the request back to Vite's own
 * static file serving by returning `/index.html`, and the SPA boots and does its own
 * client-side routing instead of the request being proxied to the API and answered as
 * `problem+json`.
 */
const API_PATHS = ['/auth', '/books', '/accounts', '/entries', '/health'];

const proxyOptions: ProxyOptions = {
  target: 'http://localhost:3000',
  changeOrigin: false,
  bypass: (req) => (req.headers.accept?.includes('text/html') ? '/index.html' : undefined),
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(API_PATHS.map((path) => [path, proxyOptions])),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
