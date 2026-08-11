import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { USER } from '../msw/handlers';

function signedIn() {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
}

async function openComposer() {
  signedIn();
  window.history.replaceState(null, '', '/books/book-1/entries/new');
  render(<App />);
  return screen.findByRole('heading', { name: /new entry/i });
}

function legRow(index: number) {
  return within(screen.getAllByRole('row')[index + 1]!);
}

async function fillLeg(index: number, accountId: string, column: 'debit' | 'credit', amount: string) {
  const user = userEvent.setup();
  const row = legRow(index);
  await user.selectOptions(row.getByLabelText(/account/i), accountId);
  await user.type(row.getByLabelText(new RegExp(column, 'i')), amount);
}

describe('the composer', () => {
  it('states the imbalance in words and in money as legs are typed', async () => {
    await openComposer();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await fillLeg(1, 'acc-sales', 'credit', '5.80');

    expect(await screen.findByText(/EUR/)).toBeInTheDocument();
    expect(screen.getByText(/debits exceed credits by 4\.20/i)).toBeInTheDocument();
  });

  it('says balanced once the currency sums to zero', async () => {
    await openComposer();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await fillLeg(1, 'acc-sales', 'credit', '10.00');

    expect(await screen.findByText(/balanced/i)).toBeInTheDocument();
  });

  it('keeps submit disabled until every currency is zero', async () => {
    await openComposer();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/description/i), 'a sale');
    expect(screen.getByRole('button', { name: /post entry/i })).toBeDisabled();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    expect(screen.getByRole('button', { name: /post entry/i })).toBeDisabled();

    await fillLeg(1, 'acc-sales', 'credit', '10.00');
    expect(screen.getByRole('button', { name: /post entry/i })).toBeEnabled();
  });

  it('refuses a zero leg, which the database would reject anyway', async () => {
    await openComposer();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/description/i), 'a sale');
    await fillLeg(0, 'acc-cash', 'debit', '0.00');
    await fillLeg(1, 'acc-sales', 'credit', '0.00');

    expect(screen.getByRole('button', { name: /post entry/i })).toBeDisabled();
  });

  it('refuses a row with both columns filled', async () => {
    await openComposer();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/description/i), 'a sale');
    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await user.type(legRow(0).getByLabelText(/credit/i), '10.00');
    await fillLeg(1, 'acc-sales', 'credit', '10.00');

    expect(screen.getByRole('button', { name: /post entry/i })).toBeDisabled();
  });

  it('adds and removes legs', async () => {
    await openComposer();
    const user = userEvent.setup();

    expect(screen.getAllByRole('row')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: /add leg/i }));
    expect(screen.getAllByRole('row')).toHaveLength(4);

    await user.click(within(screen.getAllByRole('row')[3]!).getByRole('button', { name: /remove/i }));
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('balances the outstanding amount onto an empty row', async () => {
    await openComposer();
    const user = userEvent.setup();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await user.selectOptions(legRow(1).getByLabelText(/account/i), 'acc-sales');
    await user.click(legRow(1).getByRole('button', { name: /balance/i }));

    expect(legRow(1).getByLabelText(/credit/i)).toHaveValue('10.00');
  });

  it('shows an imbalance per currency, never one total across them', async () => {
    server.use(
      http.get('/books/:bookId/accounts', () =>
        HttpResponse.json([
          { id: 'acc-cash', bookId: 'book-1', name: 'Cash', type: 'asset', currency: 'EUR', parentId: null, closedAt: null },
          { id: 'acc-usd', bookId: 'book-1', name: 'USD wallet', type: 'asset', currency: 'USD', parentId: null, closedAt: null },
        ]),
      ),
    );

    await openComposer();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await fillLeg(1, 'acc-usd', 'credit', '3.00');

    expect(await screen.findByText(/EUR/)).toBeInTheDocument();
    expect(screen.getByText(/USD/)).toBeInTheDocument();
    expect(screen.queryByText(/7\.00/)).not.toBeInTheDocument();
  });
});
