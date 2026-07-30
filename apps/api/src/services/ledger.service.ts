import { type Clock, type Money, money, parseMoney } from '@ledger/shared';
import { z } from 'zod';
import type { Executor, UnitOfWork } from '../db/client.js';
import { SQLSTATE, hasSqlState, isUniqueViolationOn } from '../db/pg-errors.js';
import {
  AccountClosedError,
  AccountNotFoundError,
  AccountNotInBookError,
  BookNotFoundError,
  CurrencyMismatchError,
  type CurrencyImbalance,
  UnbalancedEntryError,
  ValidationError,
} from '../domain/errors.js';
import type { AccountRecord, EntryRecord, LedgerRepository } from '../repositories/ledger.repository.js';
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
  async postEntry(bookId: string, input: PostEntryInput): Promise<PostEntryResult> {
    const parsed = parseInput(postEntryInputSchema, input, 'entry');
    const legs = toLegs(parsed.legs);
    assertBalanced(legs);

    const externalId = parsed.externalId ?? null;

    if (externalId !== null) {
      const existing = await this.repository.findEntryByExternalId(
        this.unitOfWork.executor,
        bookId,
        externalId,
      );
      if (existing !== null) return { entry: existing, created: false };
    }

    const recordedAt = this.clock.now();
    const entryId = this.newId();

    try {
      const entry = await this.unitOfWork.transaction(async (tx) => {
        await this.assertPostable(tx, bookId, legs);

        return this.repository.insertEntry(tx, {
          id: entryId,
          bookId,
          occurredAt: parsed.occurredAt,
          recordedAt,
          description: parsed.description,
          externalId,
          legs: legs.map((leg) => ({
            accountId: leg.accountId,
            amountMinor: leg.amount.amountMinor,
            currency: leg.amount.currency,
          })),
        });
      });

      return { entry, created: true };
    } catch (error) {
      // Two callers posted the same external_id at once and this one lost. The winner's
      // entry is the answer - the whole promise of idempotency is that the loser gets it
      // too, rather than a 409 for an operation that did in fact happen.
      if (externalId !== null && isUniqueViolationOn(error, EXTERNAL_ID_INDEX)) {
        const existing = await this.repository.findEntryByExternalId(
          this.unitOfWork.executor,
          bookId,
          externalId,
        );
        if (existing !== null) return { entry: existing, created: false };
      }

      // The application check above should have caught this. If the database raises it
      // anyway, the application check has a hole, and the entry is still rejected.
      if (hasSqlState(error, SQLSTATE.ENTRY_UNBALANCED)) {
        throw new UnbalancedEntryError([], { cause: error });
      }

      throw error;
    }
  }

  /**
   * The balance of an account, derived - always - by summing its postings.
   *
   * `asOf` is a point in *occurred* time, so a backdated entry changes the answer to a
   * question about last March. That is the correct behaviour for a ledger and the reason
   * stage 7's checkpoints are keyed on posting id: a date-keyed cache would be silently
   * invalidated by exactly this.
   */
  async getBalance(accountId: string, asOf?: Date | undefined): Promise<BalanceResult> {
    const account = await this.requireAccount(accountId);
    const total = await this.repository.sumPostings(this.unitOfWork.executor, accountId, asOf);

    return { accountId, asOf: asOf ?? null, balance: money(total, account.currency) };
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
  async listPostings(accountId: string, options: ListPostingsOptions = {}): Promise<PostingPage> {
    const { cursor, limit } = parseInput(listPostingsOptionsSchema, options, 'pagination options');
    const account = await this.requireAccount(accountId);
    const afterId = cursor === undefined ? undefined : decodePostingCursor(cursor);

    const opening =
      afterId === undefined
        ? 0n
        : await this.repository.sumPostingsThrough(this.unitOfWork.executor, accountId, afterId);

    // One row more than asked for: the cheapest way to know whether a next page exists
    // without a second count query, and the extra row is discarded.
    const rows = await this.repository.listPostings(this.unitOfWork.executor, accountId, {
      afterId,
      limit: limit + 1,
    });

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    let running = opening;
    const items = page.map((row) => {
      running += row.amountMinor;
      return {
        id: row.id,
        entryId: row.entryId,
        occurredAt: row.occurredAt,
        recordedAt: row.recordedAt,
        description: row.description,
        amount: money(row.amountMinor, row.currency),
        runningBalance: money(running, account.currency),
      };
    });

    const last = page.at(-1);

    return {
      accountId,
      items,
      nextCursor: hasMore && last !== undefined ? encodePostingCursor(last.id) : null,
    };
  }

  private async requireAccount(accountId: string): Promise<AccountRecord> {
    const account = await this.repository.findAccountById(this.unitOfWork.executor, accountId);
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
  private async assertPostable(tx: Executor, bookId: string, legs: readonly Leg[]): Promise<void> {
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
  }
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
