import type { RequestHandler } from 'express';
import { bookAccessOf } from '../http/context.js';
import { recordIdempotentEntry } from '../middleware/idempotency.js';
import { serializeBalance, serializeEntry, serializePostingPage } from '../http/serialize.js';
import { isoDateTimeQuery, paginationQuery, parseOrThrow, uuidPathParam } from '../http/validate.js';
import type { LedgerService } from '../services/ledger.service.js';
import type { RouteDefinition } from './registry.js';

/**
 * Accounts, entries, balances and statements.
 *
 * The book always comes from the guard's output, never from the path - even on the routes
 * where the path has a `:bookId` in it and the two are necessarily identical. Reading it from
 * one place means there is no version of these handlers that acts on a book the authorize
 * middleware did not approve.
 */

export interface LedgerRouteDependencies {
  readonly ledger: LedgerService;
}

export function ledgerRoutes(dependencies: LedgerRouteDependencies): RouteDefinition[] {
  const { ledger } = dependencies;

  const createAccount: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const account = await ledger.createAccount(bookId, request.body);

    response
      .status(201)
      .location(`/accounts/${account.id}`)
      .json({
        id: account.id,
        bookId: account.bookId,
        name: account.name,
        type: account.type,
        currency: account.currency,
        closedAt: account.closedAt?.toISOString() ?? null,
      });
  };

  const postEntry: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const { entry, created } = await ledger.postEntry(bookId, request.body);

    // Told to the idempotency middleware explicitly rather than sniffed out of the response
    // body, so the audit trail links an HTTP retry to the entry it produced.
    recordIdempotentEntry(response, entry.id);

    // 201 for a create, 200 for a replay of one that already existed under the same
    // external_id. Both return the same entry, which is what makes a retry after a timeout
    // safe - and the status is how a caller can tell which happened without comparing bodies.
    response
      .status(created ? 201 : 200)
      .location(`/entries/${entry.id}`)
      .json(serializeEntry(entry));
  };

  const getBalance: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const accountId = uuidPathParam(request.params, 'accountId');

    const asOf = parseOrThrow(isoDateTimeQuery, request.query.asOf, 'query');
    const balance = await ledger.getBalance(
      bookId,
      accountId,
      asOf === undefined ? undefined : new Date(asOf),
    );

    response.json(serializeBalance(balance));
  };

  const listPostings: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const accountId = uuidPathParam(request.params, 'accountId');

    const { cursor, limit } = parseOrThrow(paginationQuery, request.query, 'query');
    const page = await ledger.listPostings(bookId, accountId, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });

    response.json(serializePostingPage(page));
  };

  return [
    {
      method: 'post',
      path: '/books/:bookId/accounts',
      access: { kind: 'book', permission: 'account:create', bookFrom: 'param' },
      summary: 'Create an account in a book',
      handler: createAccount,
    },
    {
      method: 'post',
      path: '/books/:bookId/entries',
      access: { kind: 'book', permission: 'entry:post', bookFrom: 'param' },
      summary: 'Record a balanced entry',
      handler: postEntry,
    },
    {
      method: 'get',
      path: '/accounts/:accountId/balance',
      access: { kind: 'book', permission: 'book:read', bookFrom: 'account' },
      summary: 'The balance of an account, optionally as of a point in time',
      handler: getBalance,
    },
    {
      method: 'get',
      path: '/accounts/:accountId/postings',
      access: { kind: 'book', permission: 'book:read', bookFrom: 'account' },
      summary: 'One page of an account’s postings, with a running balance',
      handler: listPostings,
    },
  ];
}
