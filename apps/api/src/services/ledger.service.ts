import {
  createAccountInput as createAccountSchema,
  listPostingsInput as listPostingsOptionsSchema,
  postEntryInput as postEntryInputSchema,
  reverseEntryInput as reverseEntryInputSchema,
  type Clock,
  type CreateAccountInput,
  type ListPostingsOptions,
  type Money,
  type PostEntryInput,
  type ReverseEntryInput,
  money,
  parseMoney,
} from '@ledger/shared';
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

export type { CreateAccountInput, ListPostingsOptions, PostEntryInput, ReverseEntryInput };

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
   * Every account in a book, in one query.
   *
   * `transactionInBook` because `accounts` is behind the row-level security policy from
   * migration `0006`, so the book id has to be set on the connection before the policy will
   * return anything at all - the `WHERE` clause below it is belt as well as braces.
   */
  async listAccounts(bookId: string): Promise<AccountRecord[]> {
    return this.unitOfWork.transactionInBook(bookId, (tx) =>
      this.repository.listAccountsByBook(tx, bookId),
    );
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
   *   2. The idempotency read, inside the transaction. It began outside one - a replay is a
   *      plain SELECT - and moved in when row-level security arrived, because `entries` is
   *      behind a policy keyed on a setting that only exists within a transaction that
   *      established it. See the note at the read itself.
   *   3. Account checks and both inserts inside that same transaction, which is what lets the
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

        await this.lockAccountsAtRisk(tx, postedLegs, accounts);

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
      // This recovery is specific to this method and deliberately not part of the shared
      // translator below: `reverseEntry` never inherits an external_id, so the race it would
      // be recovering from cannot arise there.
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

      throw translateWriteFailure(error);
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
   *
   * The same SQLSTATE translation as `postEntry`, and for a reason worth stating: a reversal
   * writes the same rows through the same constraints, so it can trip LG001 and LG004 in
   * exactly the same circumstances. Without this, one database condition reached the caller as
   * a 422 through one route and a 500 through the other, which is a difference in the response
   * with no difference behind it.
   */
  async reverseEntry(
    bookId: string,
    entryId: string,
    input: ReverseEntryInput = {},
    author: Authorship = {},
  ): Promise<EntryRecord> {
    const parsed = parseInput(reverseEntryInputSchema, input, 'reversal');
    const recordedAt = this.clock.now();

    try {
      return await this.reverseEntryInTransaction(bookId, entryId, parsed, recordedAt, author);
    } catch (error) {
      throw translateWriteFailure(error);
    }
  }

  /**
   * The body of `reverseEntry`, split out so the translation above wraps a single expression.
   *
   * Inlining it would mean a `try` around the whole method and a `catch` a screen and a half
   * away from it, which is the arrangement that let the translation go missing from this path
   * in the first place. Nothing here is reusable and nothing else calls it; the split is for
   * the reader.
   */
  private async reverseEntryInTransaction(
    bookId: string,
    entryId: string,
    parsed: z.output<typeof reverseEntryInputSchema>,
    recordedAt: Date,
    author: Authorship,
  ): Promise<EntryRecord> {
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

      const accounts = await this.accountsOfLegs(tx, legs);
      await this.lockAccountsAtRisk(tx, legs, accounts);

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
      await this.assertNoOverdraft(tx, legs, accounts);

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
   * Locks every guarded account this entry could overdraw, before anything is written.
   *
   * Before, not after: a lock taken after the insert would still leave the read that decides
   * the entry's fate outside any mutual exclusion, which is the whole bug. Only the accounts
   * carrying a negative leg are locked, and that is sufficient - two transactions can only
   * jointly overdraw an account if both take money out of it, and both of those arrive here.
   *
   * A concurrent *positive* posting is therefore not blocked by this lock, and that is a
   * deliberate property rather than a gap. Adding a positive posting at time T raises the
   * prefixes at or after T and lowers none, so a depositor can never turn a decision made here
   * into the wrong one. It is also why `lockAccounts` asks for `FOR NO KEY UPDATE` rather than
   * `FOR UPDATE`: the depositor's own insert takes `FOR KEY SHARE` on the account row for the
   * foreign key check, `FOR UPDATE` would conflict with that, and a pair of mirrored transfers
   * would then deadlock on locks neither transaction knew it was taking. Under the weaker mode
   * the claim is true in the way it reads - the deposit genuinely does pass - while two
   * withdrawals from one account still serialise against each other.
   *
   * This method's own contract is unchanged either way: the accounts it names must be locked
   * in a consistent order, which is what `guardedAccountsAtRisk` sorting them provides.
   */
  private async lockAccountsAtRisk(
    tx: Executor,
    legs: readonly PostedLeg[],
    known: ReadonlyMap<string, AccountRecord>,
  ): Promise<void> {
    // Under SERIALIZABLE the database is already tracking the conflict, and an explicit lock
    // would serialise writers that SSI would have let through - paying for both mechanisms
    // and getting the worse half of each.
    if (this.unitOfWork.strategy === 'serializable') return;

    await this.repository.lockAccounts(tx, guardedAccountsAtRisk(legs, known));
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
   *
   * A short read is an error rather than a smaller map, and the asymmetry is the reason. Every
   * downstream use of this map - `guardedAccountsAtRisk`, and through it both the lock and the
   * overdraft check - treats an id it cannot find as an account that needs neither, so a
   * missing row does not fail loudly; it silently means "no lock, no check" for exactly the
   * account whose absence nobody noticed. Nothing should be able to produce that here, since
   * the composite foreign key on `postings` guarantees a parent row in the same book and this
   * runs under the same book's policy. Which is precisely why, if it ever happens, the right
   * answer is to stop rather than to write an entry under a rule that quietly did not apply.
   */
  private async accountsOfLegs(
    tx: Executor,
    legs: readonly PostedLeg[],
  ): Promise<Map<string, AccountRecord>> {
    const ids = [...new Set(legs.map((leg) => leg.accountId))];
    const found = await this.repository.findAccountsByIds(tx, ids);
    const byId = new Map(found.map((account) => [account.id, account]));

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new AccountNotFoundError(missing);

    return byId;
  }
}

/**
 * The database's answers to the two rules the application also checks, as domain errors.
 *
 * Shared by both write paths deliberately. `postEntry` and `reverseEntry` insert the same rows
 * through the same constraints, so the same SQLSTATEs are reachable from each; when only one of
 * them translated, an identical database condition was a 422 through one path and a 500 through
 * the other. There is nothing about a reversal that makes it a different kind of failure.
 *
 * Both branches are the application check having a hole. That is not a reason to leave them
 * out - it is the reason they exist. If the check is ever wrong, or two writers race in a way
 * the locks do not cover, the entry is still rejected and the caller still gets the error class
 * the fast path would have given them, rather than an unrecognised failure and a 500.
 *
 * Anything else is returned unchanged, for the caller to rethrow.
 */
function translateWriteFailure(error: unknown): unknown {
  if (hasSqlState(error, SQLSTATE.ENTRY_UNBALANCED)) {
    return new UnbalancedEntryError([], { cause: error });
  }

  // Null everywhere the detail would be, because the trigger knows which account went short
  // and by how much, and this process does not - the SQLSTATE is all that crosses back. The
  // alternative of inventing an empty string for the account id was worse than admitting the
  // gap: it put `accountId: ""` in the response, which reads as an answer rather than as its
  // absence.
  if (hasSqlState(error, SQLSTATE.ACCOUNT_OVERDRAWN)) {
    return new AccountOverdrawnError(null, null, null, { cause: error });
  }

  return error;
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
