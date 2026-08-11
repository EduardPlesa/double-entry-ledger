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

function imbalanceStrip() {
  return within(screen.getByRole('list', { name: /imbalance/i }));
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

    await screen.findByRole('list', { name: /imbalance/i });
    const strip = imbalanceStrip();
    expect(strip.getByText(/EUR/)).toBeInTheDocument();
    expect(strip.getByText(/debits exceed credits by 4\.20/i)).toBeInTheDocument();
  });

  it('says balanced once the currency sums to zero', async () => {
    await openComposer();

    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await fillLeg(1, 'acc-sales', 'credit', '10.00');

    await screen.findByRole('list', { name: /imbalance/i });
    expect(imbalanceStrip().getByText(/balanced/i)).toBeInTheDocument();
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

    await screen.findByRole('list', { name: /imbalance/i });
    const strip = imbalanceStrip();
    expect(strip.getByText(/EUR/)).toBeInTheDocument();
    expect(strip.getByText(/USD/)).toBeInTheDocument();
    expect(screen.queryByText(/7\.00/)).not.toBeInTheDocument();
  });
});

describe('posting an entry', () => {
  async function fillBalancedEntry() {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/description/i), 'a sale');
    await fillLeg(0, 'acc-cash', 'debit', '10.00');
    await fillLeg(1, 'acc-sales', 'credit', '10.00');
  }

  it('sends debits positive and credits negative, as decimal strings', async () => {
    let sent: { legs?: { amount: string; currency: string; accountId: string }[] } = {};
    server.use(
      http.post('/books/:bookId/entries', async ({ request }) => {
        sent = (await request.json()) as typeof sent;
        return HttpResponse.json({ id: 'entry-1' }, { status: 201 });
      }),
    );

    await openComposer();
    await fillBalancedEntry();
    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));

    await screen.findByText(/recorded/i);
    expect(sent.legs).toEqual([
      { accountId: 'acc-cash', amount: '10.00', currency: 'EUR' },
      { accountId: 'acc-sales', amount: '-10.00', currency: 'EUR' },
    ]);
  });

  it('carries an Idempotency-Key, and the same one on a retry', async () => {
    const keysSeen: (string | null)[] = [];
    server.use(
      http.post('/books/:bookId/entries', ({ request }) => {
        keysSeen.push(request.headers.get('idempotency-key'));
        return keysSeen.length === 1
          ? HttpResponse.json(
              { status: 503, code: 'INTERNAL_ERROR', detail: 'try again', requestId: 'req-1' },
              { status: 503, headers: { 'content-type': 'application/problem+json' } },
            )
          : HttpResponse.json({ id: 'entry-1' }, { status: 201 });
      }),
    );

    await openComposer();
    await fillBalancedEntry();

    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));
    await screen.findByText('req-1');

    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));
    await screen.findByText(/recorded/i);

    expect(keysSeen).toHaveLength(2);
    expect(keysSeen[0]).toBe(keysSeen[1]);
    expect(keysSeen[0]).not.toBeNull();
  });

  it('says an entry already existed when the API answers 200 rather than 201', async () => {
    server.use(
      http.post('/books/:bookId/entries', () => HttpResponse.json({ id: 'entry-1' }, { status: 200 })),
    );

    await openComposer();
    await fillBalancedEntry();
    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));

    expect(await screen.findByText(/already recorded/i)).toBeInTheDocument();
  });

  it('puts a rejected leg on its own row rather than in a toast', async () => {
    server.use(
      http.post('/books/:bookId/entries', () =>
        HttpResponse.json(
          {
            status: 400,
            code: 'VALIDATION_FAILED',
            detail: 'invalid request body',
            requestId: 'req-2',
            errors: [{ path: 'legs.1.amount', message: 'must not be blank' }],
          },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    await openComposer();
    await fillBalancedEntry();
    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));

    expect(await within(screen.getAllByRole('row')[2]!).findByText(/must not be blank/i)).toBeInTheDocument();
  });

  it('names the account and the shortfall when the entry would overdraw one', async () => {
    server.use(
      http.post('/books/:bookId/entries', () =>
        HttpResponse.json(
          {
            status: 422,
            code: 'ACCOUNT_OVERDRAWN',
            detail: 'account acc-cash would be overdrawn',
            requestId: 'req-3',
            accountId: 'acc-cash',
            shortfall: { currency: 'EUR', amount: '5.00' },
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    await openComposer();
    await fillBalancedEntry();
    await userEvent.click(screen.getByRole('button', { name: /post entry/i }));

    expect(await screen.findByText(/would be overdrawn/i)).toBeInTheDocument();
    expect(screen.getByText('req-3')).toBeInTheDocument();
  });
});
