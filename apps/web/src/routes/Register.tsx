import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { credentials, type CredentialsInput } from '@ledger/shared';
import { FieldError, isCode } from '../forms/FieldError';
import { useSession } from '../session/SessionProvider';
import { useToast } from '../toast/ToastProvider';

export function Register() {
  const { register: createAccount } = useSession();
  const { showError } = useToast();
  const navigate = useNavigate();

  const form = useForm<CredentialsInput>({ resolver: zodResolver(credentials) });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await createAccount(values);
      await navigate('/books');
    } catch (error) {
      // A taken address is a fact about the database, not about the form's shape, so it
      // arrives as a 409 and belongs on the field the user has to change.
      if (isCode(error, 'EMAIL_ALREADY_REGISTERED')) {
        form.setError('email', { message: error.detail });
        return;
      }

      showError(error);
    }
  });

  return (
    <main className="mx-auto mt-16 w-80">
      <h1 className="text-2xl font-semibold">Create an account</h1>

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
            autoComplete="new-password"
            {...form.register('password')}
            className="border p-2"
          />
        </label>
        <FieldError message={form.formState.errors.password?.message} />

        <button type="submit" disabled={form.formState.isSubmitting} className="border p-2">
          Create account
        </button>
      </form>

      <p className="mt-4 text-sm">
        <Link to="/login" className="underline">Sign in instead</Link>
      </p>
    </main>
  );
}
