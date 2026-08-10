import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { BookResource } from '@ledger/shared';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { USER } from '../msw/handlers';

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
    // The refresh handler is stateful rather than swapped out with a second `server.use()`
    // after `render`: MSW picks a handler at interception time, not at call time, so a handler
    // registered after `render` races the boot refresh's own request instead of deterministically
    // following it. Succeeding once and refusing thereafter makes the sequence exact: the boot
    // refresh (call 1) succeeds, so the screen mounts and its books query runs; that query's 401
    // triggers `apiFetch`'s own refresh (call 2), which this handler now refuses, and the guard
    // sends the app back to `/login`.
    let refreshCalls = 0;
    server.use(
      http.post('/auth/refresh', () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          return HttpResponse.json({ accessToken: 'access-token', user: USER });
        }
        return HttpResponse.json(
          { status: 401, code: 'UNAUTHENTICATED', detail: 'dead cookie', requestId: 'req-y' },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        );
      }),
      http.get('/books', () =>
        HttpResponse.json(
          { status: 401, code: 'UNAUTHENTICATED', detail: 'expired', requestId: 'req-x' },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    render(<App />);

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    expect(refreshCalls).toBe(2);
  });
});
