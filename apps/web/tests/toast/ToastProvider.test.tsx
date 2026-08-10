import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api/problem';
import { ToastProvider, useToast } from '../../src/toast/ToastProvider';

function Thrower({ error }: { error: unknown }) {
  const { showError } = useToast();
  return (
    <button type="button" onClick={() => { showError(error); }}>
      fail
    </button>
  );
}

function renderWith(error: unknown) {
  return render(
    <ToastProvider>
      <Thrower error={error} />
    </ToastProvider>,
  );
}

function apiError(overrides: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) {
  return new ApiError({
    status: 422,
    code: 'ACCOUNT_OVERDRAWN',
    detail: 'account would be overdrawn',
    requestId: 'req-abc',
    errors: [],
    extensions: {},
    ...overrides,
  });
}

describe('ToastProvider', () => {
  it('shows the detail and the request id of a failure', async () => {
    renderWith(apiError());
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(screen.getByText('account would be overdrawn')).toBeInTheDocument();
    expect(screen.getByText('req-abc')).toBeInTheDocument();
  });

  it('announces toasts in a live region, so a screen reader hears the failure', async () => {
    renderWith(apiError());
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(screen.getByRole('status')).toHaveTextContent('account would be overdrawn');
  });

  it('says there is no request id rather than showing an empty one', async () => {
    renderWith(apiError({ requestId: null, code: 'UNKNOWN', detail: 'the network failed' }));
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(screen.queryByRole('button', { name: /copy request id/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no request id/i)).toBeInTheDocument();
  });

  it('copies the request id to the clipboard', async () => {
    const user = userEvent.setup();
    renderWith(apiError());
    await user.click(screen.getByRole('button', { name: 'fail' }));
    await user.click(screen.getByRole('button', { name: /copy request id/i }));

    await expect(window.navigator.clipboard.readText()).resolves.toBe('req-abc');
  });

  it('dismisses one toast without dismissing the others', async () => {
    const user = userEvent.setup();
    renderWith(apiError());

    await user.click(screen.getByRole('button', { name: 'fail' }));
    await user.click(screen.getByRole('button', { name: 'fail' }));
    expect(screen.getAllByText('account would be overdrawn')).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: /dismiss/i })[0]!);
    expect(screen.getAllByText('account would be overdrawn')).toHaveLength(1);
  });

  it('shows something useful for a thrown value that is not an ApiError', async () => {
    renderWith(new TypeError('Failed to fetch'));
    await userEvent.click(screen.getByRole('button', { name: 'fail' }));

    expect(screen.getByRole('status')).toHaveTextContent(/failed to fetch/i);
  });
});
