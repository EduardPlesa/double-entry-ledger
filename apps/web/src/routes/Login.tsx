import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { credentials, type CredentialsInput } from '@ledger/shared';
import { FieldError } from '../forms/FieldError';
import { useSession } from '../session/SessionProvider';
import { useToast } from '../toast/ToastProvider';

/**
 * The credential rules are not restated here. `credentials` is the same schema
 * `AuthService.login` parses, imported from `@ledger/shared`, so a password this form accepts
 * is a password the service accepts - and the twelve-character minimum has one definition
 * rather than two that drift.
 */
export function Login() {
  const { signIn } = useSession();
  const { showError } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const form = useForm<CredentialsInput>({ resolver: zodResolver(credentials) });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await signIn(values);
      // `RequireSession` stashes where the guard caught the user before bouncing them here.
      // Falling back to `/books` covers arriving at `/login` directly, with no guard involved.
      const from = (location.state as { from?: string } | null)?.from;
      await navigate(from ?? '/books', { replace: true });
    } catch (error) {
      showError(error);
    }
  });

  return (
    <main className="mx-auto mt-16 w-80">
      <h1 className="text-2xl font-semibold">Sign in</h1>

      <form onSubmit={(event) => { void onSubmit(event); }} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          Email
          <input type="email" autoComplete="username" {...form.register('email')} className="border p-2" />
        </label>
        <FieldError message={form.formState.errors.email?.message} />

        <label className="flex flex-col gap-1">
          Password
          <input
            type="password"
            autoComplete="current-password"
            {...form.register('password')}
            className="border p-2"
          />
        </label>
        <FieldError message={form.formState.errors.password?.message} />

        <button type="submit" disabled={form.formState.isSubmitting} className="border p-2">
          Sign in
        </button>
      </form>

      <p className="mt-4 text-sm">
        <Link to="/register" className="underline">Create an account</Link>
      </p>
    </main>
  );
}
