import type { RequestHandler } from 'express';
import { ApiKeyNotPermittedError } from '../domain/errors.js';
import { bookAccessOf, principalOf } from '../http/context.js';
import type { BookService } from '../services/book.service.js';
import type { RouteDefinition } from './registry.js';

/**
 * Books, their members, and their API keys.
 *
 * Every handler here reads the book from `bookAccessOf(response)` rather than from
 * `request.params`. They are the same string - the guard put it there - but taking it from
 * the guard's output means a handler cannot accidentally act on a book that was never
 * authorized. `POST /books` is the exception, because there is no book yet.
 */

export interface BookRouteDependencies {
  readonly books: BookService;
}

export function bookRoutes(dependencies: BookRouteDependencies): RouteDefinition[] {
  const { books } = dependencies;

  const createBook: RequestHandler = async (request, response) => {
    const principal = principalOf(response);

    // A key belongs to one book. Creating a second one with it would either escape that scope
    // or produce a book the key cannot reach; neither is a permission question, which is why
    // no role makes it possible.
    if (principal.kind !== 'user') throw new ApiKeyNotPermittedError('creating a book');

    const book = await books.createBook(principal.userId, request.body);

    // 201 with Location, which is what makes this a create rather than a POST that happens to
    // return something.
    response
      .status(201)
      .location(`/books/${book.id}`)
      .json({
        id: book.id,
        name: book.name,
        baseCurrency: book.baseCurrency,
        createdAt: book.createdAt.toISOString(),
      });
  };

  const listBooks: RequestHandler = async (_request, response) => {
    response.json(await books.listBooks(principalOf(response)));
  };

  const addMember: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const { membership, user } = await books.grantRole(bookId, request.body);

    // 200 rather than 201: the operation is "this person now has this role", which is as true
    // of a change as of an addition, and there is no new resource with its own URL.
    response.status(200).json({
      bookId: membership.bookId,
      userId: membership.userId,
      email: user.email,
      role: membership.role,
    });
  };

  const issueApiKey: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const issued = await books.issueApiKey(bookId, request.body, principalOf(response));

    response
      .status(201)
      .location(`/books/${bookId}/api-keys/${issued.key.id}`)
      .json({
        id: issued.key.id,
        bookId: issued.key.bookId,
        name: issued.key.name,
        role: issued.key.role,
        prefix: issued.key.prefix,

        // The one and only time this value exists outside the caller's hands. Everything
        // stored is a SHA-256 hash, so there is no way to show it again, and saying so in the
        // response is cheaper than a support conversation later.
        token: issued.token,
        warning: 'This is the only time the key is shown. Store it now; it cannot be recovered.',
      });
  };

  return [
    {
      method: 'post',
      path: '/books',
      access: { kind: 'authenticated' },
      summary: 'Create a book, owned by the caller',
      handler: createBook,
    },
    {
      method: 'get',
      path: '/books',
      access: { kind: 'authenticated' },
      summary: 'List the books this caller can reach',
      handler: listBooks,
    },
    {
      method: 'post',
      path: '/books/:bookId/members',
      access: { kind: 'book', permission: 'member:manage', bookFrom: 'param' },
      summary: 'Grant or change a member’s role',
      handler: addMember,
    },
    {
      method: 'post',
      path: '/books/:bookId/api-keys',
      access: { kind: 'book', permission: 'member:manage', bookFrom: 'param' },
      summary: 'Issue an API key scoped to this book',
      handler: issueApiKey,
    },
  ];
}
