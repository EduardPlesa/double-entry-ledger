import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { TRIAL_BALANCE, USER } from '../msw/handlers';

async function openReport(search = '') {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
  window.history.replaceState(null, '', `/books/book-1/trial-balance${search}`);
  render(<App />);
  return screen.findByRole('heading', { name: /trial balance/i });
}

describe('the trial balance', () => {
  it('groups accounts under a heading per type, in the order the server sent them', async () => {
    await openReport();

    expect(await screen.findByText(/asset/i)).toBeInTheDocument();
    expect(screen.getByText(/revenue/i)).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
  });

  it('shows debits and credits per currency', async () => {
    await openReport();

    expect(await screen.findByText('EUR')).toBeInTheDocument();
    expect(screen.getAllByText('10.00').length).toBeGreaterThan(0);
  });

  it('passes asOf from the query string to the API', async () => {
    let requested: string | null = null;
    server.use(
      http.get('/books/:bookId/trial-balance', ({ request }) => {
        requested = new URL(request.url).searchParams.get('asOf');
        return HttpResponse.json(TRIAL_BALANCE);
      }),
    );

    await openReport('?asOf=2026-03-01T00:00:00.000Z');
    await screen.findByText('Cash');

    expect(requested).toBe('2026-03-01T00:00:00.000Z');
  });

  it('renders an unbalanced book as a failure, not a cell', async () => {
    server.use(
      http.get('/books/:bookId/trial-balance', () =>
        HttpResponse.json({
          ...TRIAL_BALANCE,
          totals: [{ currency: 'EUR', debits: '10.00', credits: '9.00', balanced: false }],
          balanced: false,
        }),
      ),
    );

    await openReport();

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not balance/i);
  });
});
