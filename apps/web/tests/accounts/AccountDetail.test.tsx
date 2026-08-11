import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { USER } from '../msw/handlers';

async function openDetail() {
  server.use(
    http.post('/auth/refresh', () => HttpResponse.json({ accessToken: 'access-token', user: USER })),
  );
  window.history.replaceState(null, '', '/accounts/acc-cash');
  render(<App />);
  return screen.findByRole('heading', { name: /cash|account/i });
}

describe('account detail', () => {
  it('shows the current balance', async () => {
    await openDetail();

    expect(await screen.findByText('6.00')).toBeInTheDocument();
  });

  it('lists postings with the running balance the server computed', async () => {
    await openDetail();

    expect(await screen.findByText('a sale')).toBeInTheDocument();

    // Two matches on purpose: the posting's amount and the running balance after it are both
    // 10.00 on the first page, so `getAllByText` is the honest matcher here.
    expect(screen.getAllByText('10.00')).toHaveLength(2);
  });

  it('loads the next page from the cursor', async () => {
    const user = userEvent.setup();
    await openDetail();
    await screen.findByText('a sale');

    await user.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('rent')).toBeInTheDocument();
  });

  it('stops offering more when the cursor runs out', async () => {
    const user = userEvent.setup();
    await openDetail();
    await screen.findByText('a sale');

    await user.click(screen.getByRole('button', { name: /load more/i }));
    await screen.findByText('rent');

    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('links a posting to the entry it belongs to', async () => {
    await openDetail();

    expect(await screen.findByRole('link', { name: /a sale/i })).toHaveAttribute(
      'href',
      '/entries/entry-1/reverse',
    );
  });
});
