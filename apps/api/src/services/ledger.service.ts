import { type Clock, type Money, money, parseMoney } from '@ledger/shared';
import { z } from 'zod';
import type { Executor, UnitOfWork } from '../db/client.js';
import { SQLSTATE, hasSqlState, isUniqueViolationOn } from '../db/pg-errors.js';
import {
  AccountClosedError,
  AccountNotFoundError,
  AccountNotInBookError,
  AccountOverdrawnError,
  BookNotFoundError,
  EntryAlreadyReversedError,
  EntryNotFoundError,
  CurrencyMismatchError,
  type CurrencyImbalance,
  UnbalancedEntryError,
  ValidationError,
} from '../domain/errors.js';
import { isGuardedAccountType } from '../domain/overdraft.js';
import type {
  AccountRecord,
  EntryRecord,
  LedgerRepository,
  PostingLine,
} from '../repositories/ledger.repository.js';
import { decodePostingCursor, encodePostingCursor } from './cursor.js';

/**
 * The ledger service: post an entry, read a balance, page through an account's postings.
 *
 * No Express and no SQL. It takes a repository, a unit of work, a clock and an id source as
 * constructor arguments, which is what makes every rule below testable without a network
 * and every timestamp in a test a value rather than a race.
 */

/** The index of the unique index behind `(book_id, external_id)`. Named so the race below can spot it. */
const EXTERNAL_ID_INDEX = 'entries_book_id_external_id_key';

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Amounts cross this boundary as decimal strings - `"12.34"`, not `1234` and not `12.34` as
 * a JSON number - and are minor-unit bigints from here inward.
 *
 * Strings because JSON numbers are IEEE 754 doubles, and a ledger that can hold a value it
 * cannot round-trip through its own API is not one you would put money in. Decimal rather
 * than minor units because the caller then does not have to know that JPY has no minor unit
 * and KWD has three; that table lives in one place, in `packages/shared`, and both sides
 * import it. The tradeoff is one parse per leg and a stricter grammar - no `1e3`, no
 * thousands separators, never more decimal places than the currency has - which is
 * `parseMoney`'s job and is tested there.
 *
 * These schemas move to `packages/shared` in stage 3, when the frontend needs to import
 * them; they start here because nothing outside the service has an opinion about them yet.
 */
const legInputSchema = z.object({
  accountId: z.uuid('must be a UUID'),
  amount: z.string(),
  currency: z.string().regex(CURRENCY_RE, 'must be a three-letter ISO 4217 code, such as EUR'),
});

const postEntryInputSchema = z.object({
  /** When it happened in the world. Asserted by the caller; never read from the clock. */
  occurredAt: z.coerce.date(),
  description: z.string().trim().min(1, 'must not be blank').max(1000),
  /**
   * Caller-supplied idempotency key. Unique per book, and the reason posting the same entry
   * twice is safe.
   */
  externalId: z.string().trim().min(1, 'must not be blank').max(255).nullish(),
  /**
   * Two legs minimum. A single-leg entry cannot sum to zero unless the leg is zero, and a
   * zero leg is rejected as well - so the alternative to this bound is a worse error message
   * later, never an accepted entry.
   */
  legs: z.array(legInputSchema).min(2, 'an entry needs at least two legs').max(1000),
});

export type PostEntryInput = z.input<typeof postEntryInputSchema>;

const listPostingsOptionsSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type ListPostingsOptions = z.input<typeof listPostingsOptionsSchema>;

/**
 * The five account types of double-entry bookkeeping, matching the Postgres enum. Fixed by
 * accounting rather than by product requirements - there will never be a sixth.
 */
const createAccountSchema = z.object({
  name: z.string().trim().min(1, 'must not be blank').max(200),
  type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  currency: z.string().regex(CURRENCY_RE, 'must be a three-letter ISO 4217 code, such as EUR'),
  parentId: z.uuid('must be a UUID').nullish(),
});

export type CreateAccountInput = z.input<typeof createAccountSchema>;

/**
 * Everything about a reversal is optional. The legs are determined by the original - that is
 * what makes it a reversal rather than a new entry that happens to look like one.
 */
const reverseEntryInputSchema = z.object({
  occurredAt: z.coerce.date().optional(),
  description: z.string().trim().min(1, 'must not be blank').max(1000).optional(),
  externalId: z.string().trim().min(1, 'must not be blank').max(255).nullish(),
});

export type ReverseEntryInput = z.input<typeof reverseEntryInputSchema>;

/**
 * Who recorded an entry. Exactly one is set for anything written through the API; both are
 * null for the rows stages 1 and 2 wrote before either table existed, and history cannot be
 * backfilled.
 */
export interface Authorship {
  readonly createdByUserId?: string | null;
  readonly createdByApiKeyId?: string | null;
}

export interface TrialBalanceLine {
  readonly accountId: string;
  readonly name: string;
  readonly type: AccountRecord['type'];
  readonly currency: string;
  readonly balance: Money;
}

export interface TrialBalanceTotal {
  readonly currency: string;
  readonly debits: Money;
  readonly credits: Money;
  readonly balanced: boolean;
}

export interface TrialBalanceResult {
  readonly bookId: string;
  readonly asOf: Date | null;
  readonly accounts: readonly TrialBalanceLine[];
  readonly totals: readonly TrialBalanceTotal[];
  readonly balanced: boolean;
}

export interface PostEntryResult {
  readonly entry: EntryRecord;
  /**
   * False when an entry with this `external_id` already existed. The HTTP layer answers 201
   * for a create and 200 for a replay; both return the same entry, which is what makes a
   * retry after a timeout safe.
   */
  readonly created: boolean;
}

export interface BalanceResult {
  readonly accountId: string;
  readonly asOf: Date | null;
  readonly balance: Money;
}

export interface PostingLineResult {
  readonly id: bigint;
  readonly entryId: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly description: string;
  readonly amount: Money;
  /** Balance of the account after this posting, in insertion order. */
  readonly runningBalance: Money;
}

export interface PostingPage {
  readonly accountId: string;
  readonly items: readonly PostingLineResult[];
  /** Null on the last page. Opaque; pass it back verbatim. */
  readonly nextCursor: string | null;
}

interface Leg {
  readonly accountId: string;
  readonly amount: Money;
}

export interface LedgerServiceDependencies {
  readonly repository: LedgerRepository;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly newId: () => string;
}

export class LedgerService {
  private readonly repository: LedgerRepository;
  private readonly unitOfWork: UnitOfWork;
  private readonly clock: Clock;
  private readonly newId: () => string;

  constructor(dependencies: LedgerServiceDependencies) {
    this.repository = dependencies.repository;
    this.unitOfWork = dependencies.unitOfWork;
    this.clock = dependencies.clock;
    this.newId = dependencies.newId;
  }

  /**
   * Creates an account in a book.
   *
   * Inside a book-scoped transaction, so the policy's WITH CHECK is what physically prevents
   * an account being written into a book the caller is not scoped to - the `bookId` here
   * comes from the authorize guard, and the database refuses anything else.
   *
   * A parent in another book is rejected by the composite foreign key, and is invisible under
   * the policy anyway; a parent that does not exist comes back as a foreign key violation.
   * Both are the database's job, not a pre-flight query's.
   */
  async createAccount(bookId: string, input: CreateAccountInput): Promise<AccountRecord> {
    const parsed = parseInput(createAccountSchema, input, 'account');

    return this.unitOfWork.transactionInBook(bookId, async (tx) => {
      if (parsed.parentId !== null && parsed.parentId !== undefined) {
        const parent = await this.repository.findAccountById(tx, parsed.parentId);
        if (parent === null) throw new AccountNotFoundError([parsed.parentId]);

        // Not a database constraint, and could not easily be one: a currency mismatch between
        // parent and child is representable and would produce a tree whose subtotals cannot
        // be added up. Rejected here, where the message can say so.
        if (parent.currency !== parsed.currency) {
          throw new CurrencyMismatchError(parsed.parentId, parent.currency, parsed.currency);
        }
      }

      return this.repository.insertAccount(tx, {
        id: this.newId(),
        bookId,
        name: parsed.name,
        type: parsed.type,
        currency: parsed.currency,
        parentId: parsed.parentId ?? null,
      });
    });
  }

  /**
   * Records an entry, or returns the one already recorded under the same `externalId`.
   *
   * The order of operations is the design:
   *
   *   1. Shape, then amounts, then zero-sum - all in memory. An unbalanced entry never opens
   *      a transaction and never reaches the database, so the common authoring mistake costs
   *      no round trip and produces an error that names the currency and the amount rather
   *      than a SQLSTATE.
   *   2. The idempotency read, outside a transaction, because a replay is a plain SELECT.
   *   3. Account checks and both inserts inside one transaction, which is what lets the
   *      deferred constraint trigger see the whole entry at COMMIT.
   *
   * Step 1 does not replace the database's check; it front-runs it. The trigger is what
   * makes the invariant true of every writer, including psql and including a future version
   * of this method with a bug in it.
   */
  async postEntry(
    bookId: string,
    input: PostEntryInput,
    author: Authorship = {},
  ): Promise<PostEntryResult> {
    const parsed = parseInput(postEntryInputSchema, input, 'entry');
    const legs = toLegs(parsed.legs);
    assertBalanced(legs);

    const externalId = parsed.externalId ?? null;
    const recordedAt = this.clock.now();
    const entryId = this.newId();

    try {
      return await this.unitOfWork.transactionInBook(bookId, async (tx) => {
        // The idempotency read moved inside the transaction when row-level security arrived:
        // `entries` is behind a policy keyed on `app.current_book_id`, and that setting only
        // exists within a transaction that established it. Reading it here rather than
        // beforehand also narrows the window the race below has to lose.
        if (externalId !== null) {
          const existing = await this.repository.findEntryByExternalId(tx, bookId, externalId);
          if (existing !== null) return { entry: existing, created: false };
        }

        const accounts = await this.assertPostable(tx, bookId, legs);

        const postedLegs = legs.map((leg) => ({
          accountId: leg.accountId,
          amountMinor: leg.amount.amountMinor,
          currency: leg.amount.currency,
        }));

        const entry = await this.repository.insertEntry(tx, {
          id: entryId,
          bookId,
          occurredAt: parsed.occurredAt,
          recordedAt,
          description: parsed.description,
          externalId,
          createdByUserId: author.createdByUserId ?? null,
          createdByApiKeyId: author.createdByApiKeyId ?? null,
          legs: postedLegs,
        });

        await this.assertNoOverdraft(tx, postedLegs, accounts);

        return { entry, created: true };
      });
    } catch (error) {
      // Two callers posted the same external_id at once and this one lost. The winner's
      // entry is the answer - the whole promise of idempotency is that the loser gets it
      // too, rather than a 409 for an operation that did in fact happen.
      //
      // A second transaction, because the one that raised is aborted and cannot be read
      // from. It is book-scoped like the first: the policy does not care that this read is
      // recovering from an error.
      if (externalId !== null && isUniqueViolationOn(error, EXTERNAL_ID_INDEX)) {
        const existing = await this.unitOfWork.transactionInBook(bookId, (tx) =>
          this.repository.findEntryByExternalId(tx, bookId, externalId),
        );
        if (existing !== null) return { entry: existing, created: false };
      }

      // The application check above should have caught this. If the database raises it
      // anyway, the application check has a hole, and the entry is still rejected.
      if (hasSqlState(error, SQLSTATE.ENTRY_UNBALANCED)) {
        throw new UnbalancedEntryError([], { cause: error });
      }

      // The application check above should have caught this too. When the database raises it
      // anyway, two writers raced and one of them lost at COMMIT - which is the failure mode
      // this stage exists to characterise, and which the row locks below remove. Either way
      // the entry is rejected, and the caller gets the same error class as the fast path.
      if (hasSqlState(error, SQLSTATE.ACCOUNT_OVERDRAWN)) {
        throw new AccountOverdrawnError('', null, null, { cause: error });
      }

      throw error;
    }
  }

  /**
   * Reverses an entry by recording a new one with every leg negated.
   *
   * This is the only correction mechanism the system has, and it is a consequence of invariant
   * 2 rather than a policy choice: entries and postings cannot be updated or deleted by any
   * role, so an error in the record is fixed by adding to the record, never by rewriting it.
   * The original stays exactly as it was, and both entries remain visible - which is the
   * behaviour an auditor expects and the reason the trial balance still adds up afterwards.
   *
   * A reversal is itself an ordinary entry, so reversing one is permitted. What is not is
   * reversing the same entry twice, which would double the correction.
   */
  async reverseEntry(
    bookId: string,
    entryId: string,
    input: ReverseEntryInput = {},
    author: Authorship = {},
  ): Promise<EntryRecord> {
    const parsed = parseInput(reverseEntryInputSchema, input, 'reversal');
    const recordedAt = this.clock.now();

    return this.unitOfWork.transactionInBook(bookId, async (tx) => {
      const original = await this.repository.findEntryById(tx, entryId);

      // Under row-level security an entry in another book is not visible, so this covers both
      // "no such entry" and "not yours" - and answers the same way for each, which is the
      // point.
      if (original === null) throw new EntryNotFoundError(entryId);

      const existing = await this.repository.findReversalOf(tx, entryId);
      if (existing !== null) throw new EntryAlreadyReversedError(entryId, existing.id);

      const legs = original.postings.map((posting) => ({
        accountId: posting.accountId,
        amountMinor: -posting.amountMinor,
        currency: posting.currency,
      }));

      const reversal = await this.repository.insertEntry(tx, {
        id: this.newId(),
        bookId,

        // When the correction happens, not when the original did. Backdating a reversal to
        // the original's date would make a balance that was correct as of last March silently
        // change, and "what did we believe on the 31st" would stop having an answer.
        occurredAt: parsed.occurredAt ?? recordedAt,
        recordedAt,
        description: parsed.description ?? `Reversal of: ${original.description}`,

        // Deliberately not inherited. `external_id` is unique per book, so copying the
        // original's would collide, and a reversal is a different event that deserves its own
        // idempotency key or none at all.
        externalId: parsed.externalId ?? null,

        reversalOf: entryId,
        createdByUserId: author.createdByUserId ?? null,
        createdByApiKeyId: author.createdByApiKeyId ?? null,

        legs,
      });

      // A reversal is not exempt. An entry that cannot be reversed without overdrawing an
      // account is one whose reversal alone is not the correction, and the error says how
      // much has to be deposited first.
      await this.assertNoOverdraft(tx, legs, await this.accountsOfLegs(tx, legs));

      return reversal;
    });
  }

  /**
   * The trial balance: every account with its balance, and the proof that the book adds up.
   *
   * The totals are per currency, not per book. A book's `base_currency` is a default for
   * reporting, not a claim that everything in it is denominated that way, and adding a EUR
   * balance to a USD one produces a number that means nothing. Each currency balances on its
   * own or the book is broken, which is the same rule the zero-sum invariant applies to a
   * single entry.
   *
   * Debits and credits are the positive and negative balances stated separately. In a system
   * that stores signed amounts they carry no information the sum does not - `balanced` is
   * exactly `debits === credits` is exactly `sum === 0` - but they are how the report is read,
   * and a trial balance that made an accountant do the arithmetic would be an odd thing to
   * ship.
   */
  async trialBalance(bookId: string, asOf?: Date | undefined): Promise<TrialBalanceResult> {
    const rows = await this.unitOfWork.transactionInBook(bookId, (tx) =>
      this.repository.trialBalance(tx, bookId, asOf),
    );

    const accounts = rows.map((row) => ({
      accountId: row.accountId,
      name: row.name,
      type: row.type,
      currency: row.currency,
      balance: money(row.balanceMinor, row.currency),
    }));

    const byCurrency = new Map<string, { debits: bigint; credits: bigint }>();
    for (const row of rows) {
      const totals = byCurrency.get(row.currency) ?? { debits: 0n, credits: 0n };

      if (row.balanceMinor > 0n) totals.debits += row.balanceMinor;
      else totals.credits += -row.balanceMinor;

      byCurrency.set(row.currency, totals);
    }

    const totals = [...byCurrency]
      .map(([currency, { debits, credits }]) => ({
        currency,
        debits: money(debits, currency),
        credits: money(credits, currency),
        balanced: debits === credits,
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

    return {
      bookId,
      asOf: asOf ?? null,
      accounts,
      totals,
      // The assertion the report exists to make. False here means the database has been
      // written to by something that bypassed the deferred constraint trigger, which should
      // be impossible - so it is worth stating rather than assuming.
      balanced: totals.every((total) => total.balanced),
    };
  }

  /**
   * The balance of an account, derived - always - by summing its postings.
   *
   * `asOf` is a point in *occurred* time, so a backdated entry changes the answer to a
   * question about last March. That is the correct behaviour for a ledger and the reason
   * stage 7's checkpoints are keyed on posting id: a date-keyed cache would be silently
   * invalidated by exactly this.
   */
  async getBalance(bookId: string, accountId: string, asOf?: Date | undefined): Promise<BalanceResult> {
    return this.unitOfWork.transactionInBook(bookId, async (tx) => {
      const account = await this.requireAccount(tx, accountId);
      const total = await this.repository.sumPostings(tx, accountId, asOf);

      return { accountId, asOf: asOf ?? null, balance: money(total, account.currency) };
    });
  }

  /**
   * One page of an account's postings, oldest first, each with the balance after it.
   *
   * A bounded number of queries per page - three, or two on the first page - regardless of
   * page size, so this cannot become an N+1. The running balance starts from the sum of
   * everything up to the cursor, which is a fresh sum-from-zero on every page and therefore
   * the slow part; stage 7 replaces that one query with a checkpoint lookup and asserts the
   * two agree.
   *
   * Every posting on an account shares the account's currency - the composite foreign key on
   * `postings` makes any other combination unrepresentable - so a single running total is
   * well defined here in a way it would not be for a book.
   */
  async listPostings(
    bookId: string,
    accountId: string,
    options: ListPostingsOptions = {},
  ): Promise<PostingPage> {
    const { cursor, limit } = parseInput(listPostingsOptionsSchema, options, 'pagination options');
    const afterId = cursor === undefined ? undefined : decodePostingCursor(cursor);

    return this.unitOfWork.transactionInBook(bookId, async (tx) => {
      const account = await this.requireAccount(tx, accountId);

      const opening =
        afterId === undefined
          ? 0n
          : await this.repository.sumPostingsThrough(tx, accountId, afterId);

      // One row more than asked for: the cheapest way to know whether a next page exists
      // without a second count query, and the extra row is discarded.
      const rows = await this.repository.listPostings(tx, accountId, {
        afterId,
        limit: limit + 1,
      });

      return buildPostingPage({ accountId, currency: account.currency, rows, limit, opening });
    });
  }

  /**
   * The account, or a not-found error.
   *
   * Under row-level security an account belonging to a different book is not visible at all,
   * so this raises `AccountNotFoundError` for it rather than `AccountNotInBookError`. That is
   * the answer the caller should get anyway: confirming that an account exists somewhere else
   * tells someone with an id something they have not been authorised to learn.
   */
  private async requireAccount(tx: Executor, accountId: string): Promise<AccountRecord> {
    const account = await this.repository.findAccountById(tx, accountId);
    if (account === null) throw new AccountNotFoundError([accountId]);
    return account;
  }

  /**
   * Everything the database would reject anyway, checked here for the sake of the message.
   *
   * A leg pointing at another book's account, or at an account holding a different currency,
   * violates a composite foreign key and comes back as `23503` naming a constraint. Same
   * outcome, unusable explanation. A closed account is the exception: the database does not
   * know about it, so this is the only enforcement, which is why it happens inside the
   * transaction rather than before it.
   */
  private async assertPostable(
    tx: Executor,
    bookId: string,
    legs: readonly Leg[],
  ): Promise<Map<string, AccountRecord>> {
    const accountIds = [...new Set(legs.map((leg) => leg.accountId))];
    const found = await this.repository.findAccountsByIds(tx, accountIds);
    const byId = new Map(found.map((account) => [account.id, account]));

    const missing = accountIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      // Only now is it worth a query to tell "this book has no such account" apart from
      // "there is no such book". On the happy path that question never gets asked.
      if (!(await this.repository.bookExists(tx, bookId))) throw new BookNotFoundError(bookId);
      throw new AccountNotFoundError(missing);
    }

    for (const leg of legs) {
      const account = byId.get(leg.accountId);
      if (account === undefined) continue;

      if (account.bookId !== bookId) throw new AccountNotInBookError(leg.accountId, bookId);
      if (account.closedAt !== null) throw new AccountClosedError(leg.accountId, account.closedAt);
      if (account.currency !== leg.amount.currency) {
        throw new CurrencyMismatchError(leg.accountId, account.currency, leg.amount.currency);
      }
    }

    return byId;
  }

  /**
   * The overdraft rule: no guarded account may be negative at any point in its history.
   *
   * Run *after* the insert, deliberately. The new postings are then simply part of the
   * history the query examines, so there is no pending state to merge with committed state
   * and reversals need no separate code path. A violation throws and the transaction rolls
   * back, which is the same bargain the deferred zero-sum trigger makes.
   *
   * Only accounts carrying a *negative* leg are checked. If every leg on an account is
   * non-negative no prefix can fall: all legs of an entry share one `occurred_at`, and new
   * postings take ids above every existing row, so prefixes before the entry are untouched
   * and every prefix at or after it rises. Note that a positive *net* is not enough - an
   * entry with -100 and +150 on one account nets +50 and dips to -100 in between.
   *
   * This implementation is correct exactly as long as nothing else is writing. Stage 4's
   * whole point is that READ COMMITTED does not make that true; `evidence/overdraft-race`
   * has the proof and the row locks are what fix it.
   */
  private async assertNoOverdraft(
    tx: Executor,
    legs: readonly PostedLeg[],
    known: ReadonlyMap<string, AccountRecord>,
  ): Promise<void> {
    for (const accountId of guardedAccountsAtRisk(legs, known)) {
      const lowest = await this.repository.lowestPrefixBalance(tx, accountId);
      if (lowest === null || lowest.balanceMinor >= 0n) continue;

      const account = known.get(accountId);
      throw new AccountOverdrawnError(
        accountId,
        { currency: account?.currency ?? '', amountMinor: lowest.balanceMinor },
        lowest.occurredAt,
      );
    }
  }

  /**
   * The accounts an entry's legs refer to, as records. `postEntry` already has them from
   * `assertPostable`; `reverseEntry` does not, because its legs come from the original entry
   * rather than from user input that had to be validated.
   */
  private async accountsOfLegs(
    tx: Executor,
    legs: readonly PostedLeg[],
  ): Promise<Map<string, AccountRecord>> {
    const ids = [...new Set(legs.map((leg) => leg.accountId))];
    const found = await this.repository.findAccountsByIds(tx, ids);
    return new Map(found.map((account) => [account.id, account]));
  }
}

/**
 * Rows plus an opening balance become a page with a running balance.
 *
 * Extracted from `listPostings` so that the method reads as the four database calls it makes
 * and this reads as the arithmetic it is. Nothing here touches the database, which is also
 * what makes the off-by-one in the `limit + 1` trick reviewable in one place.
 */
function buildPostingPage(input: {
  accountId: string;
  currency: string;
  rows: readonly PostingLine[];
  limit: number;
  opening: bigint;
}): PostingPage {
  const page = input.rows.slice(0, input.limit);
  const hasMore = input.rows.length > input.limit;

  let running = input.opening;
  const items = page.map((row) => {
    running += row.amountMinor;
    return {
      id: row.id,
      entryId: row.entryId,
      occurredAt: row.occurredAt,
      recordedAt: row.recordedAt,
      description: row.description,
      amount: money(row.amountMinor, row.currency),
      runningBalance: money(running, input.currency),
    };
  });

  const last = page.at(-1);

  return {
    accountId: input.accountId,
    items,
    nextCursor: hasMore && last !== undefined ? encodePostingCursor(last.id) : null,
  };
}

function parseInput<T extends z.ZodType>(schema: T, input: unknown, subject: string): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new ValidationError(
    `invalid ${subject}: ${z.prettifyError(result.error)}`,
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
    { cause: result.error },
  );
}

/** Decimal strings become minor-unit bigints here, and stay bigints from here on. */
function toLegs(legs: readonly { accountId: string; amount: string; currency: string }[]): Leg[] {
  return legs.map((leg, index) => {
    let amount: Money;
    try {
      amount = parseMoney(leg.amount, leg.currency);
    } catch (error) {
      throw new ValidationError(
        `invalid entry: legs.${String(index)}.amount ${error instanceof Error ? error.message : ''}`.trim(),
        [{ path: `legs.${String(index)}.amount`, message: error instanceof Error ? error.message : 'invalid' }],
        { cause: error },
      );
    }

    // A zero leg carries no information and no accounting meaning, and the database rejects
    // it with a CHECK. Caught here so the reply names the leg.
    if (amount.amountMinor === 0n) {
      throw new ValidationError(`invalid entry: legs.${String(index)}.amount must not be zero`, [
        { path: `legs.${String(index)}.amount`, message: 'must not be zero' },
      ]);
    }

    return { accountId: leg.accountId, amount };
  });
}

/** A leg as it is written: minor units, not `Money`. What both write paths have in common. */
interface PostedLeg {
  readonly accountId: string;
  readonly amountMinor: bigint;
}

/**
 * Which accounts this entry could possibly overdraw: guarded, and taking money out.
 *
 * Sorted, so the order accounts are checked - and, from the row-lock fix onwards, locked -
 * is a property of the data rather than of how the caller happened to order the legs. Two
 * concurrent entries touching the same pair of accounts in opposite order would otherwise
 * deadlock.
 */
function guardedAccountsAtRisk(
  legs: readonly PostedLeg[],
  known: ReadonlyMap<string, AccountRecord>,
): string[] {
  const atRisk = new Set<string>();

  for (const leg of legs) {
    if (leg.amountMinor >= 0n) continue;

    const account = known.get(leg.accountId);
    if (account !== undefined && isGuardedAccountType(account.type)) atRisk.add(account.id);
  }

  return [...atRisk].sort();
}

/**
 * Invariant 1, in application code: every currency the entry touches sums to zero on its
 * own. Grouping by currency rather than summing everything is the whole point - a EUR leg
 * and a USD leg that cancel numerically cancel nothing at all.
 */
function assertBalanced(legs: readonly Leg[]): void {
  const totals = new Map<string, bigint>();
  for (const leg of legs) {
    totals.set(leg.amount.currency, (totals.get(leg.amount.currency) ?? 0n) + leg.amount.amountMinor);
  }

  const imbalances: CurrencyImbalance[] = [...totals]
    .filter(([, total]) => total !== 0n)
    .map(([currency, total]) => ({ currency, amountMinor: total }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  if (imbalances.length > 0) throw new UnbalancedEntryError(imbalances);
}
