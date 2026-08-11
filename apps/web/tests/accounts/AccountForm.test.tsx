import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { AccountForm } from '../../src/accounts/AccountForm';
import { ToastProvider } from '../../src/toast/ToastProvider';
import { server } from '../msw/server';

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AccountForm bookId="book-1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('AccountForm', () => {
  it('creates an account with the five types offered and nothing else', async () => {
    const user = userEvent.setup();
    let sent: unknown = null;

    server.use(
      http.post('/books/:bookId/accounts', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json({ id: 'acc-new' }, { status: 201 });
      }),
    );

    renderForm();

    await user.type(screen.getByLabelText(/name/i), 'Rent');
    await user.selectOptions(screen.getByLabelText(/type/i), 'expense');
    await user.type(screen.getByLabelText(/currency/i), 'EUR');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await screen.findByRole('button', { name: /create account/i });
    expect(sent).toEqual({ name: 'Rent', type: 'expense', currency: 'EUR' });

    const options = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(options).toEqual(['asset', 'liability', 'equity', 'revenue', 'expense']);
  });

  it('rejects a lowercase currency without calling the API', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/books/:bookId/accounts', () => {
        throw new Error('the API must not be called for a currency the schema rejects');
      }),
    );

    renderForm();

    await user.type(screen.getByLabelText(/name/i), 'Rent');
    await user.selectOptions(screen.getByLabelText(/type/i), 'expense');
    await user.type(screen.getByLabelText(/currency/i), 'eur');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/three-letter ISO 4217 code/i)).toBeInTheDocument();
  });

  it('surfaces a refusal as a toast carrying the request id', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/books/:bookId/accounts', () =>
        HttpResponse.json(
          { status: 422, code: 'CURRENCY_MISMATCH', detail: 'the parent holds USD', requestId: 'req-acc' },
          { status: 422, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    renderForm();

    await user.type(screen.getByLabelText(/name/i), 'Rent');
    await user.selectOptions(screen.getByLabelText(/type/i), 'expense');
    await user.type(screen.getByLabelText(/currency/i), 'EUR');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText('the parent holds USD')).toBeInTheDocument();
    expect(screen.getByText('req-acc')).toBeInTheDocument();
  });
});
