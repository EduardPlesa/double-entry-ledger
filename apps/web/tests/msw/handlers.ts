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
