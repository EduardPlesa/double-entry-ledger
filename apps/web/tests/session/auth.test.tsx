import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { server } from '../msw/server';
import { USER } from '../msw/handlers';

function signedIn() {
  server.use(
    http.post('/auth/refresh', () =>
      HttpResponse.json({
        accessToken: 'access-token',
        tokenType: 'Bearer',
        expiresAt: '2026-08-05T12:10:00.000Z',
        user: USER,
      }),
    ),
  );
}

describe('booting', () => {
  it('shows the login form when the refresh cookie is dead', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });

  it('restores the session from the refresh cookie without showing a login form', async () => {
    signedIn();
    render(<App />);

    expect(await screen.findByText(USER.email)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /sign in/i })).not.toBeInTheDocument();
  });
});

describe('signing in', () => {
  it('signs in and lands on the books screen', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText(/email/i), 'owner@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(USER.email)).toBeInTheDocument();
  });

  it('refuses to submit a password shorter than the schema allows, without calling the API', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/auth/login', () => {
        throw new Error('the API must not be called for a password the schema rejects');
      }),
    );

    render(<App />);

    await user.type(await screen.findByLabelText(/email/i), 'owner@example.com');
    await user.type(screen.getByLabelText(/password/i), 'short');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
  });

  it('surfaces a rejected credential as a toast carrying the request id', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/auth/login', () =>
        HttpResponse.json(
          {
            status: 401,
            code: 'UNAUTHENTICATED',
            detail: 'email or password is incorrect',
            requestId: 'req-login',
          },
          { status: 401, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    render(<App />);

    await user.type(await screen.findByLabelText(/email/i), 'owner@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('email or password is incorrect')).toBeInTheDocument();
    expect(screen.getByText('req-login')).toBeInTheDocument();
  });
});

describe('registering', () => {
  it('creates an account and signs in', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('link', { name: /create an account/i }));
    await user.type(screen.getByLabelText(/email/i), 'new@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(USER.email)).toBeInTheDocument();
  });

  it('puts a taken email on the email field rather than in a toast', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/auth/register', () =>
        HttpResponse.json(
          {
            status: 409,
            code: 'EMAIL_ALREADY_REGISTERED',
            detail: 'that email is already registered',
            requestId: 'req-dup',
          },
          { status: 409, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    render(<App />);

    await user.click(await screen.findByRole('link', { name: /create an account/i }));
    await user.type(screen.getByLabelText(/email/i), 'taken@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/already registered/i)).toBeInTheDocument();
  });
});

describe('signing out', () => {
  it('returns to the login form', async () => {
    const user = userEvent.setup();
    signedIn();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /sign out/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    });
  });
});
