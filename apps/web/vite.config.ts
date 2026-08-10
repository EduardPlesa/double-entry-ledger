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
