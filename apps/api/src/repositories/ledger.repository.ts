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
