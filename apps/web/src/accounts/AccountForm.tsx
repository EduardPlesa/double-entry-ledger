import { useMutation, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { createAccountInput, type AccountResource, type CreateAccountInput } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';
import { FieldError } from '../forms/FieldError';
import { useToast } from '../toast/ToastProvider';

/**
 * The five types are the five of double-entry bookkeeping, and they come from the same Zod
 * enum the service validates against - so a sixth cannot appear here without appearing there.
 */
const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export function AccountForm({ bookId }: { bookId: string }) {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const form = useForm<CreateAccountInput>({ resolver: zodResolver(createAccountInput) });

  const create = useMutation({
    mutationFn: (input: CreateAccountInput) =>
      apiFetch<AccountResource>(`/books/${bookId}/accounts`, { method: 'POST', body: input }),
    onSuccess: async () => {
      form.reset();
      await queryClient.invalidateQueries({ queryKey: keys.accounts(bookId) });
    },
    onError: showError,
  });

  const onSubmit = form.handleSubmit((values) => {
    create.mutate(values);
  });

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        Name
        <input {...form.register('name')} className="border p-2" />
      </label>
      <FieldError message={form.formState.errors.name?.message} />

      <label className="flex flex-col gap-1">
        Type
        <select {...form.register('type')} className="border p-2">
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <FieldError message={form.formState.errors.type?.message} />

      <label className="flex flex-col gap-1">
        Currency
        <input {...form.register('currency')} className="border p-2" />
      </label>
      <FieldError message={form.formState.errors.currency?.message} />

      <button type="submit" disabled={create.isPending} className="border p-2">
        Create account
      </button>
    </form>
  );
}
