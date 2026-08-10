import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { createBookInput, type BookResource, type CreateBookInput } from '@ledger/shared';
import { apiFetch } from '../api/client';
import { keys } from '../api/keys';
import { FieldError } from '../forms/FieldError';
import { useToast } from '../toast/ToastProvider';

export function useBooks() {
  return useQuery({
    queryKey: keys.books(),
    queryFn: () => apiFetch<BookResource[]>('/books'),
  });
}

export function BookList({ books }: { books: readonly BookResource[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-2">
      {books.map((book) => (
        <li key={book.id} className="flex items-center justify-between border p-3">
          <Link to={`/books/${book.id}/accounts`} className="underline">
            {book.name}
          </Link>
          <span className="text-sm text-gray-600">
            {book.baseCurrency} · <span>{book.role}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The role comes from the server, on the book.
 *
 * It is here so the UI can decline to offer what `domain/policy.ts` forbids - a viewer should
 * not be shown a compose button whose only outcome is a 403. The server still decides; this
 * only stops the client asking.
 */
export function CreateBookForm({ heading }: { heading: string }) {
  const queryClient = useQueryClient();
  const { showError } = useToast();

  const form = useForm<CreateBookInput>({ resolver: zodResolver(createBookInput) });

  const create = useMutation({
    mutationFn: (input: CreateBookInput) =>
      apiFetch<BookResource>('/books', { method: 'POST', body: input }),
    onSuccess: async () => {
      form.reset();
      await queryClient.invalidateQueries({ queryKey: keys.books() });
    },
    onError: showError,
  });

  const onSubmit = form.handleSubmit((values) => {
    create.mutate(values);
  });

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">{heading}</h2>

      <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          Name
          <input {...form.register('name')} className="border p-2" />
        </label>
        <FieldError message={form.formState.errors.name?.message} />

        <label className="flex flex-col gap-1">
          Base currency
          <input {...form.register('baseCurrency')} className="border p-2" />
        </label>
        <FieldError message={form.formState.errors.baseCurrency?.message} />

        <button type="submit" disabled={create.isPending} className="border p-2">
          Create book
        </button>
      </form>
    </section>
  );
}
