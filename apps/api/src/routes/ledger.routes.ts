import {
  accountList,
  accountResource,
  balanceResource,
  createAccountInput,
  entryResource,
  postEntryInput,
  postingPageResource,
  reverseEntryInput,
  trialBalanceResource,
} from '@ledger/shared';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { authorshipOf, bookAccessOf, principalOf } from '../http/context.js';
import { recordIdempotentEntry } from '../middleware/idempotency.js';
import {
  serializeAccount,
  serializeBalance,
  serializeEntry,
  serializePostingPage,
  serializeTrialBalance,
} from '../http/serialize.js';
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

  /**
   * `asOf` as a query object rather than the bare value the handlers used to parse.
   *
   * The rule is the same one `isoDateTimeQuery` always stated; what changed is that the spec
   * lists parameters per key, and a schema for one value has no key to list. The handlers
   * below parse through this, so the published parameter and the enforced one are one object.
   */
  const asOfQuery = z.object({ asOf: isoDateTimeQuery });

  const createAccount: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const account = await ledger.createAccount(bookId, request.body);

    response.status(201).location(`/accounts/${account.id}`).json(serializeAccount(account));
  };

  const listAccounts: RequestHandler = async (_request, response) => {
    const { bookId } = bookAccessOf(response);
    const accounts = await ledger.listAccounts(bookId);

    response.json(accounts.map(serializeAccount));
  };

  const postEntry: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const { entry, created, reversedBy } = await ledger.postEntry(
      bookId,
      request.body,
      authorshipOf(principalOf(response)),
    );

    // Told to the idempotency middleware explicitly rather than sniffed out of the response
    // body, so the audit trail links an HTTP retry to the entry it produced.
    recordIdempotentEntry(response, entry.id);

    // 201 for a create, 200 for a replay of one that already existed under the same
    // external_id. Both return the same entry, which is what makes a retry after a timeout
    // safe - and the status is how a caller can tell which happened without comparing bodies.
    //
    // `reversedBy` is asserted `null` on the create branch rather than threaded through: the
    // service never looks it up there because nothing can have reversed an entry this call
    // just inserted. On a replay the entry was recorded earlier and may since have been
    // reversed, so the service's answer is passed through unchanged.
    response
      .status(created ? 201 : 200)
      .location(`/entries/${entry.id}`)
      .json(serializeEntry(entry, created ? null : reversedBy));
  };

  const getBalance: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const accountId = uuidPathParam(request.params, 'accountId');

    const { asOf } = parseOrThrow(asOfQuery, request.query, 'query');
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

  const reverseEntry: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const entryId = uuidPathParam(request.params, 'entryId');

    const reversal = await ledger.reverseEntry(
      bookId,
      entryId,
      request.body,
      authorshipOf(principalOf(response)),
    );

    recordIdempotentEntry(response, reversal.id);

    // 201: a reversal is a new entry with its own id and its own URL, not a modification of
    // the one it corrects. That is the whole shape of the domain in one status code.
    //
    // `reversedBy` is `null` as a fact, not a placeholder: this entry was inserted a moment
    // ago by this same request, so it cannot itself already have a reversal.
    response.status(201).location(`/entries/${reversal.id}`).json(serializeEntry(reversal, null));
  };

  const getEntry: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);
    const entryId = uuidPathParam(request.params, 'entryId');

    const { entry, reversedBy } = await ledger.getEntry(bookId, entryId);

    response.json(serializeEntry(entry, reversedBy));
  };

  const trialBalance: RequestHandler = async (request, response) => {
    const { bookId } = bookAccessOf(response);

    const { asOf } = parseOrThrow(asOfQuery, request.query, 'query');
    const report = await ledger.trialBalance(bookId, asOf === undefined ? undefined : new Date(asOf));

    response.json(serializeTrialBalance(report));
  };

  // The three path shapes, declared once each. The guard has already parsed the real value
  // through `uuidPathParam` by the time any handler runs; these exist so the spec can list the
  // parameter. `RouteDefinition` says why that is the one place a rule is written twice.
  const bookPath = { params: z.object({ bookId: z.uuid() }) };
  const accountPath = { params: z.object({ accountId: z.uuid() }) };
  const entryPath = { params: z.object({ entryId: z.uuid() }) };

  return [
    {
      method: 'post',
      path: '/books/:bookId/accounts',
      access: { kind: 'book', permission: 'account:create', bookFrom: 'param' },
      summary: 'Create an account in a book',
      request: { ...bookPath, body: createAccountInput },
      response: { status: 201, schema: accountResource },
      handler: createAccount,
    },
    {
      method: 'get',
      path: '/books/:bookId/accounts',
      access: { kind: 'book', permission: 'book:read', bookFrom: 'param' },
      summary: 'List the accounts of a book',
      request: bookPath,
      response: { status: 200, schema: accountList },
      handler: listAccounts,
    },
    {
      method: 'post',
      path: '/books/:bookId/entries',
      access: { kind: 'book', permission: 'entry:post', bookFrom: 'param' },
      summary: 'Record a balanced entry',
      request: { ...bookPath, body: postEntryInput },
      response: { status: 201, schema: entryResource },
      alsoAnswers: [
        {
          status: 200,
          description:
            'An entry with this `externalId` already existed in this book. The body is that ' +
            'entry, unchanged - which is what makes retrying a timed-out post safe.',
        },
      ],
      handler: postEntry,
    },
    {
      method: 'get',
      path: '/accounts/:accountId/balance',
      access: { kind: 'book', permission: 'book:read', bookFrom: 'account' },
      summary: 'The balance of an account, optionally as of a point in time',
      request: { ...accountPath, query: asOfQuery },
      response: { status: 200, schema: balanceResource },
      handler: getBalance,
    },
    {
      method: 'get',
      path: '/accounts/:accountId/postings',
      access: { kind: 'book', permission: 'book:read', bookFrom: 'account' },
      summary: 'One page of an account’s postings, with a running balance',
      request: { ...accountPath, query: paginationQuery },
      response: { status: 200, schema: postingPageResource },
      handler: listPostings,
    },
    {
      method: 'post',
      path: '/entries/:entryId/reverse',
      access: { kind: 'book', permission: 'entry:reverse', bookFrom: 'entry' },
      summary: 'Reverse an entry by recording its negation',
      request: { ...entryPath, body: reverseEntryInput },
      response: { status: 201, schema: entryResource },
      handler: reverseEntry,
    },
    {
      method: 'get',
      path: '/entries/:entryId',
      access: { kind: 'book', permission: 'book:read', bookFrom: 'entry' },
      summary: 'Read one entry and the reversal that cancels it',
      request: entryPath,
      response: { status: 200, schema: entryResource },
      handler: getEntry,
    },
    {
      method: 'get',
      path: '/books/:bookId/trial-balance',
      access: { kind: 'book', permission: 'book:read', bookFrom: 'param' },
      summary: 'Every account with its balance, and the proof the book adds up',
      request: { ...bookPath, query: asOfQuery },
      response: { status: 200, schema: trialBalanceResource },
      handler: trialBalance,
    },
  ];
}
