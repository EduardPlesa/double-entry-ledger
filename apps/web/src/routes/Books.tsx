import { BookList, CreateBookForm, useBooks } from '../books/BookPicker';
import { useSession } from '../session/SessionProvider';

export function Books() {
  const { user, signOut } = useSession();
  const books = useBooks();

  return (
    <main className="mx-auto mt-8 w-[40rem]">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Books</h1>
        <div className="flex items-center gap-3 text-sm">
          <span>{user?.email}</span>
          <button type="button" onClick={() => { void signOut(); }} className="underline">
            Sign out
          </button>
        </div>
      </header>

      {books.isPending ? <p className="mt-4">Loading…</p> : null}

      {books.data !== undefined && books.data.length > 0 ? <BookList books={books.data} /> : null}

      {books.data !== undefined && books.data.length === 0 ? (
        <CreateBookForm heading="Create your first book" />
      ) : null}
    </main>
  );
}
