import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { ACCOUNTS, USER } from '../msw/handlers';

async function openTree() {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
  window.history.replaceState(null, '', '/books/book-1/accounts');
  render(<App />);
  return screen.findByRole('heading', { name: /accounts/i });
}

describe('the account tree', () => {
  it('shows each account with its balance', async () => {
    await openTree();

    expect(await screen.findByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('10.00')).toBeInTheDocument();
    expect(screen.getByText('-10.00')).toBeInTheDocument();
  });

  it('nests a child under its parent', async () => {
    server.use(
      http.get('/books/:bookId/accounts', () =>
        HttpResponse.json([
          ...ACCOUNTS,
          { id: 'acc-petty', bookId: 'book-1', name: 'Petty cash', type: 'asset', currency: 'EUR', parentId: 'acc-cash', closedAt: null },
        ]),
      ),
    );

    await openTree();

    const petty = await screen.findByText('Petty cash');
    expect(petty.closest('li')?.parentElement?.closest('li')).toHaveTextContent('Cash');
  });

  it('hides closed accounts behind a toggle', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/books/:bookId/accounts', () =>
        HttpResponse.json([
          ...ACCOUNTS,
          { id: 'acc-old', bookId: 'book-1', name: 'Old account', type: 'asset', currency: 'EUR', parentId: null, closedAt: '2026-01-01T00:00:00.000Z' },
        ]),
      ),
    );

    await openTree();
    expect(await screen.findByText('Old account')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /show closed/i }));
    expect(screen.queryByText('Old account')).not.toBeInTheDocument();
  });

  it('links each account to its detail', async () => {
    await openTree();

    expect(await screen.findByRole('link', { name: 'Cash' })).toHaveAttribute('href', '/accounts/acc-cash');
  });

  it('keeps a subtree total the same whether the toggle hides closed accounts or not', async () => {
    // Filtering before the tree is built would reparent Petty cash onto the root and drop
    // Old cash's balance from the subtree total - so the toggle would change a number that is
    // supposed to be a display decision. This proves it does not.
    server.use(
      http.get('/books/:bookId/accounts', () =>
        HttpResponse.json([
          { id: 'acc-cash', bookId: 'book-1', name: 'Cash', type: 'asset', currency: 'EUR', parentId: null, closedAt: null },
          {
            id: 'acc-old-cash',
            bookId: 'book-1',
            name: 'Old cash',
            type: 'asset',
            currency: 'EUR',
            parentId: 'acc-cash',
            closedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ),
      http.get('/books/:bookId/trial-balance', () =>
        HttpResponse.json({
          bookId: 'book-1',
          asOf: null,
          accounts: [
            { accountId: 'acc-cash', name: 'Cash', type: 'asset', currency: 'EUR', balance: '10.00' },
            { accountId: 'acc-old-cash', name: 'Old cash', type: 'asset', currency: 'EUR', balance: '5.00' },
          ],
          totals: [{ currency: 'EUR', debits: '15.00', credits: '0.00', balanced: false }],
          balanced: false,
        }),
      ),
    );

    const user = userEvent.setup();
    await openTree();

    expect(await screen.findByText(/including children: 15\.00 EUR/i)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /show closed/i }));

    expect(screen.queryByText('Old cash')).not.toBeInTheDocument();
    expect(screen.getByText(/including children: 15\.00 EUR/i)).toBeInTheDocument();
  });
});
