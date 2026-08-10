import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

describe('App', () => {
  it('lands on the login screen when booted with no session', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();
  });
});
