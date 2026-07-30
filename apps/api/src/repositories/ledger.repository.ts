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
  readonly legs: readonly {
    readonly accountId: string;
    readonly amountMinor: bigint;
    readonly currency: string;
  }[];
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

export interface LedgerRepository {
  bookExists(executor: Executor, bookId: string): Promise<boolean>;
  findAccountsByIds(executor: Executor, accountIds: readonly string[]): Promise<AccountRecord[]>;
  findAccountById(executor: Executor, accountId: string): Promise<AccountRecord | null>;
  findEntryByExternalId(
    executor: Executor,
    bookId: string,
    externalId: string,
  ): Promise<EntryRecord | null>;
  insertEntry(executor: Executor, entry: NewEntry): Promise<EntryRecord>;
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
