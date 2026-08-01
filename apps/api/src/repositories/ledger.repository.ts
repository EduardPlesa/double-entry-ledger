import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Executor } from '../db/client.js';
import { accounts, books, entries, postings } from '../db/schema.js';

/**
 * Data access. No business rules live here: this module knows how to read and write rows,
 * and nothing about what makes a set of them a valid entry. The zero-sum check, the
 * idempotency decision and the running balance are all in the service, because they are
 * things about the domain rather than things about SQL.
 *
 * Every method takes an `Executor`, so the caller decides whether it runs inside a
 * transaction. Amounts are `bigint` at every boundary. Sums are cast to `::text` in SQL and
 * converted with `BigInt()`, because a `sum()` over bigint returns numeric, and numeric
 * arrives as a string that would otherwise be tempting to hand to `Number()`.
 */

export interface AccountRecord {
  readonly id: string;
  readonly bookId: string;
  readonly name: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  readonly currency: string;
  readonly closedAt: Date | null;
}

export interface PostingRecord {
  readonly id: bigint;
  readonly entryId: string;
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface EntryRecord {
  readonly id: string;
  readonly bookId: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly description: string;
  readonly externalId: string | null;
  readonly reversalOf: string | null;
  readonly postings: readonly PostingRecord[];
}

/** An entry and its legs, ready to be written. Ids are chosen by the caller. */
export interface NewEntry {
  readonly id: string;
  readonly bookId: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly description: string;
  readonly externalId: string | null;
  /** Set when this entry reverses another. Null for an ordinary entry. */
  readonly reversalOf?: string | null;
  /** Exactly one of these is set for anything written through the API. */
  readonly createdByUserId?: string | null;
  readonly createdByApiKeyId?: string | null;
  readonly legs: readonly {
    readonly accountId: string;
    readonly amountMinor: bigint;
    readonly currency: string;
  }[];
}

/** One line of the trial balance: an account and what it holds. */
export interface TrialBalanceRow {
  readonly accountId: string;
  readonly name: string;
  readonly type: AccountRecord['type'];
  readonly currency: string;
  readonly balanceMinor: bigint;
}

/**
 * The lowest the account's balance ever gets, and when. `balanceMinor` is a running total,
 * not a single posting: it is the sum of every posting up to and including that point.
 */
export interface LowestPrefix {
  readonly balanceMinor: bigint;
  readonly occurredAt: Date;
}

/** A posting joined to the entry that explains it, which is what a statement line is. */
export interface PostingLine {
  readonly id: bigint;
  readonly entryId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly description: string;
}

export interface BookRecord {
  readonly id: string;
  readonly name: string;
  readonly baseCurrency: string;
  readonly createdAt: Date;
}

export interface NewAccount {
  readonly id: string;
  readonly bookId: string;
  readonly name: string;
  readonly type: AccountRecord['type'];
  readonly currency: string;
  readonly parentId: string | null;
}

export interface LedgerRepository {
  bookExists(executor: Executor, bookId: string): Promise<boolean>;
  insertBook(executor: Executor, book: BookRecord): Promise<BookRecord>;
  insertAccount(executor: Executor, account: NewAccount): Promise<AccountRecord>;
  /**
   * The book an account belongs to, or null. Readable without a book context, which is the
   * only reason it can be the first step of establishing one.
   */
  bookOfAccount(executor: Executor, accountId: string): Promise<string | null>;
  bookOfEntry(executor: Executor, entryId: string): Promise<string | null>;
  findAccountsByIds(executor: Executor, accountIds: readonly string[]): Promise<AccountRecord[]>;
  findAccountById(executor: Executor, accountId: string): Promise<AccountRecord | null>;
  findEntryByExternalId(
    executor: Executor,
    bookId: string,
    externalId: string,
  ): Promise<EntryRecord | null>;
  findEntryById(executor: Executor, entryId: string): Promise<EntryRecord | null>;
  /** The entry that reverses this one, if there is one. */
  findReversalOf(executor: Executor, entryId: string): Promise<{ id: string } | null>;
  insertEntry(executor: Executor, entry: NewEntry): Promise<EntryRecord>;
  /** Every account in the book with its balance, including the ones with no postings. */
  trialBalance(executor: Executor, bookId: string, asOf?: Date | undefined): Promise<TrialBalanceRow[]>;
  /** Sum of an account's postings, optionally as of a point in *occurred* time. */
  sumPostings(executor: Executor, accountId: string, asOf?: Date | undefined): Promise<bigint>;
  /** Sum of an account's postings up to and including a posting id. The cursor's opening balance. */
  sumPostingsThrough(executor: Executor, accountId: string, throughId: bigint): Promise<bigint>;
  /**
   * The minimum running balance over the account's history, or null if it has no postings.
   * The overdraft rule is exactly `balanceMinor >= 0`.
   */
  lowestPrefixBalance(executor: Executor, accountId: string): Promise<LowestPrefix | null>;
  /**
   * Takes a `FOR NO KEY UPDATE` row lock on each account, in ascending id order. Blocks until
   * any transaction holding a conflicting lock commits or rolls back. The mode matters and the
   * implementation explains why: `FOR UPDATE` would conflict with the `FOR KEY SHARE` a
   * posting's foreign key check takes on the same rows.
   */
  lockAccounts(executor: Executor, accountIds: readonly string[]): Promise<void>;
  listPostings(
    executor: Executor,
    accountId: string,
    options: { afterId: bigint | undefined; limit: number },
  ): Promise<PostingLine[]>;
}

export class DrizzleLedgerRepository implements LedgerRepository {
  async bookExists(executor: Executor, bookId: string): Promise<boolean> {
    const rows = await executor.select({ id: books.id }).from(books).where(eq(books.id, bookId)).limit(1);
    return rows.length > 0;
  }

  /**
   * `books` has no row-level security policy, so this works outside a book context - which it
   * has to, since the book does not exist yet and cannot be the current one.
   */
  async insertBook(executor: Executor, book: BookRecord): Promise<BookRecord> {
    const [inserted] = await executor.insert(books).values(book).returning();
    if (inserted === undefined) throw new Error(`insert of book ${book.id} returned no row`);
    return inserted;
  }

  /**
   * `accounts` does have a policy, so this must run inside a transaction with the book
   * context set - and the WITH CHECK clause is what stops a caller scoped to one book from
   * writing an account into another.
   */
  async insertAccount(executor: Executor, account: NewAccount): Promise<AccountRecord> {
    const [inserted] = await executor.insert(accounts).values(account).returning({
      id: accounts.id,
      bookId: accounts.bookId,
      name: accounts.name,
      type: accounts.type,
      currency: accounts.currency,
      closedAt: accounts.closedAt,
    });

    if (inserted === undefined) throw new Error(`insert of account ${account.id} returned no row`);
    return inserted;
  }

  /**
   * Both of these call the SECURITY DEFINER functions from migration 0006 rather than
   * selecting from the table. That is the whole point of them: `accounts` and `entries` are
   * behind a policy keyed on the book, so an ordinary SELECT here would need the answer it
   * is being asked to produce. The functions run as the table owner, return exactly one uuid
   * and nothing else, and are the only sanctioned way out of that circle.
   */
  async bookOfAccount(executor: Executor, accountId: string): Promise<string | null> {
    const result = await executor.execute<{ book_id: string | null }>(
      sql`select book_of_account(${accountId}) as book_id`,
    );
    return result.rows[0]?.book_id ?? null;
  }

  async bookOfEntry(executor: Executor, entryId: string): Promise<string | null> {
    const result = await executor.execute<{ book_id: string | null }>(
      sql`select book_of_entry(${entryId}) as book_id`,
    );
    return result.rows[0]?.book_id ?? null;
  }

  async findAccountsByIds(executor: Executor, accountIds: readonly string[]): Promise<AccountRecord[]> {
    if (accountIds.length === 0) return [];
    return executor
      .select({
        id: accounts.id,
        bookId: accounts.bookId,
        name: accounts.name,
        type: accounts.type,
        currency: accounts.currency,
        closedAt: accounts.closedAt,
      })
      .from(accounts)
      .where(inArray(accounts.id, [...accountIds]));
  }

  async findAccountById(executor: Executor, accountId: string): Promise<AccountRecord | null> {
    const [account] = await this.findAccountsByIds(executor, [accountId]);
    return account ?? null;
  }

  /**
   * Two queries rather than a join, because a join would repeat every entry column once per
   * leg and then need taking apart again. Entries have a handful of postings, so this is two
   * index lookups, not an N+1: the count is fixed regardless of how many legs come back.
   */
  async findEntryByExternalId(
    executor: Executor,
    bookId: string,
    externalId: string,
  ): Promise<EntryRecord | null> {
    const [entry] = await executor
      .select()
      .from(entries)
      .where(and(eq(entries.bookId, bookId), eq(entries.externalId, externalId)))
      .limit(1);

    if (entry === undefined) return null;

    return { ...entry, postings: await this.postingsOfEntry(executor, entry.id) };
  }

  async findEntryById(executor: Executor, entryId: string): Promise<EntryRecord | null> {
    const [entry] = await executor.select().from(entries).where(eq(entries.id, entryId)).limit(1);
    if (entry === undefined) return null;

    return { ...entry, postings: await this.postingsOfEntry(executor, entry.id) };
  }

  /**
   * Whether anything already reverses this entry.
   *
   * Stage 4 makes this impossible to get wrong by adding a partial unique index on
   * `reversal_of`, at which point this read becomes an optimisation and the database becomes
   * the enforcement. Until then it is the only thing standing between an entry and two
   * reversals, and two concurrent requests can both pass it - which is exactly the class of
   * bug stage 4 exists to demonstrate.
   */
  async findReversalOf(executor: Executor, entryId: string): Promise<{ id: string } | null> {
    const [reversal] = await executor
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.reversalOf, entryId))
      .limit(1);

    return reversal ?? null;
  }

  /**
   * Every account in the book, with the sum of its postings.
   *
   * A LEFT JOIN, so an account with no postings appears with a balance of zero rather than
   * vanishing. A trial balance that silently omitted the accounts it found least interesting
   * would be a strange sort of report.
   *
   * One query, not one per account. The obvious implementation - list the accounts, then ask
   * for each balance - is the N+1 that stage 5's query-count assertion is meant to catch, and
   * it is worth not writing in the first place.
   */
  async trialBalance(
    executor: Executor,
    bookId: string,
    asOf?: Date | undefined,
  ): Promise<TrialBalanceRow[]> {
    // An aggregate FILTER rather than a condition in the JOIN or the WHERE, and both of those
    // are wrong in ways worth naming. In the WHERE, the filter discards the null rows the
    // outer join produces and quietly turns it back into an inner join, so accounts with no
    // qualifying postings disappear. In the JOIN to `entries`, it excludes the entry but not
    // the posting - the posting row survives with null entry columns and its amount is still
    // summed. FILTER applies to the aggregate itself, which is the only place the question
    // "should this amount count" actually belongs.
    const total =
      asOf === undefined
        ? sql<string>`coalesce(sum(${postings.amountMinor}), 0)::text`
        : sql<string>`coalesce(sum(${postings.amountMinor}) filter (where ${entries.occurredAt} <= ${asOf}), 0)::text`;

    const rows = await executor
      .select({
        accountId: accounts.id,
        name: accounts.name,
        type: accounts.type,
        currency: accounts.currency,
        // ::text, then BigInt. A sum over bigint returns numeric, and numeric arrives as a
        // string that would otherwise be tempting to hand to Number().
        total,
      })
      .from(accounts)
      .leftJoin(postings, eq(postings.accountId, accounts.id))
      .leftJoin(entries, eq(entries.id, postings.entryId))
      .where(eq(accounts.bookId, bookId))
      .groupBy(accounts.id, accounts.name, accounts.type, accounts.currency)
      .orderBy(asc(accounts.type), asc(accounts.name));

    return rows.map((row) => ({
      accountId: row.accountId,
      name: row.name,
      type: row.type,
      currency: row.currency,
      balanceMinor: BigInt(row.total),
    }));
  }

  private async postingsOfEntry(executor: Executor, entryId: string): Promise<PostingRecord[]> {
    return executor
      .select({
        id: postings.id,
        entryId: postings.entryId,
        accountId: postings.accountId,
        amountMinor: postings.amountMinor,
        currency: postings.currency,
      })
      .from(postings)
      .where(eq(postings.entryId, entryId))
      .orderBy(asc(postings.id));
  }

  /**
   * The entry and all its legs, in one round trip each.
   *
   * Both statements must run in the same transaction, and the caller is responsible for
   * that: the entry row is unbalanced - in fact legless - between the two, and only the
   * deferred constraint trigger's decision to wait until COMMIT makes that intermediate
   * state legal. Running these on a pool handle would fail on the first statement, which is
   * the correct outcome for a mistake that would otherwise be silent.
   */
  async insertEntry(executor: Executor, entry: NewEntry): Promise<EntryRecord> {
    const [inserted] = await executor
      .insert(entries)
      .values({
        id: entry.id,
        bookId: entry.bookId,
        occurredAt: entry.occurredAt,
        recordedAt: entry.recordedAt,
        description: entry.description,
        externalId: entry.externalId,
        reversalOf: entry.reversalOf ?? null,
        createdByUserId: entry.createdByUserId ?? null,
        createdByApiKeyId: entry.createdByApiKeyId ?? null,
      })
      .returning();

    if (inserted === undefined) {
      throw new Error(`insert of entry ${entry.id} returned no row`);
    }

    const insertedPostings = await executor
      .insert(postings)
      .values(
        entry.legs.map((leg) => ({
          entryId: entry.id,
          bookId: entry.bookId,
          accountId: leg.accountId,
          amountMinor: leg.amountMinor,
          currency: leg.currency,
        })),
      )
      .returning({
        id: postings.id,
        entryId: postings.entryId,
        accountId: postings.accountId,
        amountMinor: postings.amountMinor,
        currency: postings.currency,
      });

    return { ...inserted, postings: insertedPostings };
  }

  /**
   * Sum from zero, every time. Naive on purpose and correct by construction: the balance is
   * derived from the postings, never stored, so it cannot drift from them. Stage 7 adds
   * checkpoints keyed on posting id and a test asserting this path and that one always
   * agree - which is only possible because this one still exists.
   *
   * `asOf` filters on `occurred_at`, when the transaction happened in the world, not on
   * `recorded_at`, when we learned of it. Those differ for backdated entries, and answering
   * "what did we believe the March balance was on March 31" needs both; that is the
   * bitemporal extension, not this.
   */
  async sumPostings(executor: Executor, accountId: string, asOf?: Date | undefined): Promise<bigint> {
    const conditions = [eq(postings.accountId, accountId)];
    if (asOf !== undefined) conditions.push(lte(entries.occurredAt, asOf));

    const [row] = await executor
      .select({ total: sql<string>`coalesce(sum(${postings.amountMinor}), 0)::text` })
      .from(postings)
      .innerJoin(entries, eq(entries.id, postings.entryId))
      .where(and(...conditions));

    return BigInt(row?.total ?? '0');
  }

  async sumPostingsThrough(executor: Executor, accountId: string, throughId: bigint): Promise<bigint> {
    const [row] = await executor
      .select({ total: sql<string>`coalesce(sum(${postings.amountMinor}), 0)::text` })
      .from(postings)
      .where(and(eq(postings.accountId, accountId), lte(postings.id, throughId)));

    return BigInt(row?.total ?? '0');
  }

  /**
   * The lowest point the account's balance ever reaches.
   *
   * A window function rather than a sum, because the overdraft rule is about every prefix of
   * the account's history and not about its total. Those differ precisely when an entry is
   * backdated - which `occurred_at` exists to allow - and the difference is a withdrawal that
   * overdrew the account on the date it claims to describe while today's balance looks fine.
   *
   * `ORDER BY e.occurred_at, p.id`, and the tiebreaker is load-bearing. Two legs of one entry
   * always share an `occurred_at`, so without it the window has no defined order among them
   * and "the minimum prefix" is not a single number. `p.id` is a bigserial: a total order,
   * consistent with the sequence rows were recorded in.
   *
   * Raw SQL rather than the query builder because drizzle has no window-function API, and
   * writing it out is clearer than assembling it from fragments. It reads only `postings` and
   * `entries`, both behind row-level security, so it must run inside a book-scoped
   * transaction like everything else here.
   */
  async lowestPrefixBalance(executor: Executor, accountId: string): Promise<LowestPrefix | null> {
    const result = await executor.execute<{ balance: string; occurred_at: Date }>(sql`
      select running::text as balance, occurred_at
      from (
        select
          sum(${postings.amountMinor}) over (
            order by ${entries.occurredAt}, ${postings.id}
            rows between unbounded preceding and current row
          ) as running,
          ${entries.occurredAt} as occurred_at
        from ${postings}
        join ${entries} on ${entries.id} = ${postings.entryId}
        where ${postings.accountId} = ${accountId}
      ) prefixes
      order by running asc, occurred_at asc
      limit 1
    `);

    const row = result.rows[0];
    if (row === undefined) return null;

    return { balanceMinor: BigInt(row.balance), occurredAt: new Date(row.occurred_at) };
  }

  /**
   * Row locks on the accounts an entry could overdraw.
   *
   * The lock is on `accounts`, not on `postings`, and that is the point: the rows being
   * inserted do not exist yet, so there is nothing there to lock. The account row is a
   * pre-existing thing every writer to that account has to go through, which turns "check
   * then insert" into a decision only one transaction can be making at a time.
   *
   * `FOR NO KEY UPDATE`, and the choice of mode is load-bearing rather than cautious. Only the
   * accounts an entry takes money *out* of are locked here, but an entry writes postings to
   * every account it touches, and inserting a posting makes Postgres verify
   * `postings_account_same_book_currency_fk` against the parent row - which it does by taking
   * `FOR KEY SHARE` on that `accounts` row. That is a lock this code never requests and never
   * gets to order. `FOR UPDATE` conflicts with `FOR KEY SHARE`, so under it a transfer of
   * `[cash -1, bank +1]` held `cash` explicitly and then waited on `bank` implicitly, while
   * the mirrored `[bank -1, cash +1]` did the reverse, and Postgres broke the tie with a
   * 40P01 on a pair of entirely legitimate transfers. `FOR NO KEY UPDATE` still conflicts with
   * itself - two withdrawals from one account serialise exactly as before, which is the only
   * thing the lock is here to do - but it does not conflict with `FOR KEY SHARE`, so foreign
   * key checks and concurrent deposits pass straight through. The crossed-transfer test in
   * `tests/concurrency/deadlock.test.ts` is the before-and-after: it reproduces a real 40P01
   * against `for update` and passes against this.
   *
   * Two entries touching the same two accounts in opposite leg order must not take the locks
   * in opposite orders, or they wait on each other forever. Two things stand between this
   * method and that failure. `guardedAccountsAtRisk`, in the service, sorts the ids before
   * they ever reach here - every caller this method actually has always hands it ids already
   * in ascending order, and that is the mechanism the end-to-end test in
   * `tests/concurrency/deadlock.test.ts` exercises. `ORDER BY id` below is this method's own,
   * independent line of defence, for a caller that does not sort - which is exactly what the
   * direct test alongside that one does, calling this method with the same two ids in
   * deliberately reversed order on two genuinely concurrent connections.
   *
   * That direct test cannot, on the schema as it stands, tell `ORDER BY id` apart from its
   * absence. `accounts` has two btree indexes that lead with `id` - the primary key, and the
   * composite unique index this query actually plans against - and `EXPLAIN` shows the same
   * plan, with no `Sort` node anywhere, whether this clause is present, absent, or reversed to
   * `DESC` (which only flips the index scan to run backward). Postgres's own array-key
   * handling for an indexed `IN (...)` already visits the matching rows in ascending `id`
   * order regardless of the order the list was written in, so removing this clause and
   * re-running the direct test - tried locally while fixing this comment - still shows no
   * deadlock. `ORDER BY id` is kept anyway: it states the contract this method actually
   * promises rather than one it happens to get for free from an index that could be dropped or
   * reshaped later, and it is what would matter again the day that index stops leading with
   * `id`.
   *
   * Nothing is returned. The rows are already known to the caller - this statement exists
   * for its side effect, which is the honest description of a lock.
   *
   * Built with the query builder rather than a raw `sql` template. Embedding a plain JS array
   * in a `sql` tag expands it positionally - `any(($1, $2))` - which Postgres parses as a row
   * constructor, not an array, and rejects with `op ANY/ALL (array) requires array on right
   * side` the moment two accounts are locked at once. `inArray` binds the ids as an actual
   * array parameter instead.
   */
  async lockAccounts(executor: Executor, accountIds: readonly string[]): Promise<void> {
    if (accountIds.length === 0) return;

    await executor
      .select({ id: accounts.id })
      .from(accounts)
      .where(inArray(accounts.id, [...accountIds]))
      .orderBy(asc(accounts.id))
      .for('no key update');
  }

  /**
   * One page of an account's postings, oldest first.
   *
   * Ordered by posting id, which is a bigserial and therefore both unique and monotonic in
   * insertion order. That gives a keyset cursor with no tiebreaker column and no risk of a
   * row being skipped or repeated as the table grows underneath the reader - neither of
   * which OFFSET can promise. It is also the only ordering in which a running balance means
   * anything: it is the balance after each posting was recorded, and that requires a total
   * order everyone agrees on.
   */
  async listPostings(
    executor: Executor,
    accountId: string,
    options: { afterId: bigint | undefined; limit: number },
  ): Promise<PostingLine[]> {
    const conditions = [eq(postings.accountId, accountId)];
    if (options.afterId !== undefined) conditions.push(gt(postings.id, options.afterId));

    return executor
      .select({
        id: postings.id,
        entryId: postings.entryId,
        amountMinor: postings.amountMinor,
        currency: postings.currency,
        occurredAt: entries.occurredAt,
        recordedAt: entries.recordedAt,
        description: entries.description,
      })
      .from(postings)
      .innerJoin(entries, eq(entries.id, postings.entryId))
      .where(and(...conditions))
      .orderBy(asc(postings.id))
      .limit(options.limit);
  }
}
