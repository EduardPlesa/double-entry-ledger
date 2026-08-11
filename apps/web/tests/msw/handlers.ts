import { http, HttpResponse } from 'msw';
import type { AccountResource, BookResource, TrialBalanceResource } from '@ledger/shared';

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
  http.get('/books/:bookId/accounts', () => HttpResponse.json(ACCOUNTS)),
  http.get('/books/:bookId/trial-balance', () => HttpResponse.json(TRIAL_BALANCE)),
];
