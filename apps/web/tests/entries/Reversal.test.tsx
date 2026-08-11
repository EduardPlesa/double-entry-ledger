import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { ENTRY, USER } from '../msw/handlers';

async function openReversal() {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
  window.history.replaceState(null, '', '/entries/entry-1/reverse');
  render(<App />);
  return screen.findByRole('heading', { name: /reverse/i });
}

describe('the reversal flow', () => {
  it('shows before, delta and after for each affected account', async () => {
    // The default trial-balance fixture carries acc-cash at 10.00, which the entry's own 10.00
    // cash leg would net to zero either way - not a useful check that `before` and `after` are
    // actually distinct rows in the table. Overriding to a balance the leg does not consume
    // gives before=1200.00, after=1190.00, the same pair `impact.test.ts` proves the arithmetic
    // for, so this test is checking that the screen wires that arithmetic to the DOM rather than
    // re-proving the arithmetic itself.
    server.use(
      http.get('/books/:bookId/trial-balance', () =>
        HttpResponse.json({
          bookId: 'book-1',
          asOf: null,
          accounts: [
            { accountId: 'acc-cash', name: 'Cash', type: 'asset', currency: 'EUR', balance: '1200.00' },
            { accountId: 'acc-sales', name: 'Sales', type: 'revenue', currency: 'EUR', balance: '-50.00' },
          ],
          totals: [{ currency: 'EUR', debits: '1200.00', credits: '1200.00', balanced: true }],
          balanced: true,
        }),
      ),
    );

    await openReversal();

    expect(await screen.findByText('1200.00')).toBeInTheDocument();
    expect(screen.getByText('1190.00')).toBeInTheDocument();
  });

  it('warns when a projected balance goes negative, without promising a refusal', async () => {
    server.use(
      http.get('/books/:bookId/trial-balance', () =>
        HttpResponse.json({
          bookId: 'book-1',
          asOf: null,
          accounts: [{ accountId: 'acc-cash', name: 'Cash', type: 'asset', currency: 'EUR', balance: '5.00' }],
          totals: [{ currency: 'EUR', debits: '5.00', credits: '5.00', balanced: true }],
          balanced: true,
        }),
      ),
    );

    await openReversal();

    expect(await screen.findByText(/may refuse/i)).toBeInTheDocument();
  });

  it('refuses to offer a reversal for an entry already reversed', async () => {
    server.use(
      http.get('/entries/:entryId', () => HttpResponse.json({ ...ENTRY, reversedBy: 'entry-2' })),
    );

    await openReversal();

    expect(await screen.findByText(/already reversed/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reverse this entry/i })).not.toBeInTheDocument();
  });

  it('posts the reversal with an idempotency key', async () => {
    let key: string | null = null;
    server.use(
      http.post('/entries/:entryId/reverse', ({ request }) => {
        key = request.headers.get('idempotency-key');
        return HttpResponse.json({ id: 'entry-2' }, { status: 201 });
      }),
    );

    await openReversal();
    await userEvent.click(await screen.findByRole('button', { name: /reverse this entry/i }));

    await screen.findByText(/reversed/i);
    expect(key).not.toBeNull();
  });

  it('surfaces an overdraft refusal with the account and the shortfall', async () => {
    server.use(
      http.post('/entries/:entryId/reverse', () =>
        HttpResponse.json(
          {
            status: 422,
            code: 'ACCOUNT_OVERDRAWN',
            detail: 'account acc-cash would be overdrawn',
            requestId: 'req-rev',
            accountId: 'acc-cash',
            shortfall: { currency: 'EUR', amount: '5.00' },
          },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    await openReversal();
    await userEvent.click(await screen.findByRole('button', { name: /reverse this entry/i }));

    expect(await screen.findByText(/would be overdrawn/i)).toBeInTheDocument();
    expect(screen.getByText('req-rev')).toBeInTheDocument();
  });
});
