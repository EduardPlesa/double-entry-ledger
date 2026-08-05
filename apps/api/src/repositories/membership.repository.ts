import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Executor } from '../db/client.js';
import type { BookRole } from '../domain/policy.js';
import { apiKeys, bookMembers, books } from '../db/schema.js';

/**
 * Memberships and API keys: the two ways a caller comes to have a role in a book.
 *
 * Neither table is behind row-level security, and neither could be - answering "may this
 * caller see this book" has to happen before there is a book context to answer it inside of.
 * That is the same reason the users table has no policy.
 */

export interface MembershipRecord {
  readonly bookId: string;
  readonly userId: string;
  readonly role: BookRole;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly bookId: string;
  readonly role: BookRole;
  readonly prefix: string;
  readonly name: string;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface BookSummary {
  readonly id: string;
  readonly name: string;
  readonly baseCurrency: string;
  readonly createdAt: Date;
}

export interface BookMembershipRecord extends BookSummary {
  readonly role: BookRole;
}

export interface NewApiKey {
  readonly id: string;
  readonly bookId: string;
  readonly role: BookRole;
  readonly tokenHash: string;
  readonly prefix: string;
  readonly name: string;
  readonly createdByUserId: string | null;
}

export interface MembershipRepository {
  findMembership(executor: Executor, bookId: string, userId: string): Promise<MembershipRecord | null>;
  /** Adds a member, or changes the role of one who is already there. */
  grantRole(executor: Executor, bookId: string, userId: string, role: BookRole): Promise<MembershipRecord>;

  /** The books this user is a member of, with the role held in each, ordered by name. */
  listBooksForUser(executor: Executor, userId: string): Promise<BookMembershipRecord[]>;
  findBookById(executor: Executor, bookId: string): Promise<BookSummary | null>;

  insertApiKey(executor: Executor, key: NewApiKey): Promise<ApiKeyRecord>;
  findLiveApiKeyByHash(executor: Executor, tokenHash: string): Promise<ApiKeyRecord | null>;
  /** Advances `last_used_at`, but only if it is stale. Returns whether it wrote. */
  touchApiKey(executor: Executor, apiKeyId: string, now: Date, staleAfterMs: number): Promise<boolean>;
}

const apiKeyColumns = {
  id: apiKeys.id,
  bookId: apiKeys.bookId,
  role: apiKeys.role,
  prefix: apiKeys.prefix,
  name: apiKeys.name,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
};

export class DrizzleMembershipRepository implements MembershipRepository {
  async findMembership(
    executor: Executor,
    bookId: string,
    userId: string,
  ): Promise<MembershipRecord | null> {
    const [membership] = await executor
      .select({ bookId: bookMembers.bookId, userId: bookMembers.userId, role: bookMembers.role })
      .from(bookMembers)
      .where(and(eq(bookMembers.bookId, bookId), eq(bookMembers.userId, userId)))
      .limit(1);

    return membership ?? null;
  }

  /**
   * Insert, or update the role if the row is already there.
   *
   * One statement rather than a read followed by a write, because two owners promoting the
   * same person at once would otherwise race and one would get a primary key violation for
   * doing something entirely reasonable. There is no delete branch: `book_members` has no
   * DELETE grant, and demoting to viewer is the supported way to take access away - it
   * leaves a row saying the person was once there.
   */
  async grantRole(
    executor: Executor,
    bookId: string,
    userId: string,
    role: BookRole,
  ): Promise<MembershipRecord> {
    const [granted] = await executor
      .insert(bookMembers)
      .values({ bookId, userId, role })
      .onConflictDoUpdate({ target: [bookMembers.bookId, bookMembers.userId], set: { role } })
      .returning({ bookId: bookMembers.bookId, userId: bookMembers.userId, role: bookMembers.role });

    if (granted === undefined) throw new Error(`grant of ${role} in book ${bookId} returned no row`);
    return granted;
  }

  async listBooksForUser(executor: Executor, userId: string): Promise<BookMembershipRecord[]> {
    return executor
      .select({
        id: books.id,
        name: books.name,
        baseCurrency: books.baseCurrency,
        createdAt: books.createdAt,
        role: bookMembers.role,
      })
      .from(bookMembers)
      .innerJoin(books, eq(books.id, bookMembers.bookId))
      .where(eq(bookMembers.userId, userId))
      .orderBy(books.name);
  }

  async findBookById(executor: Executor, bookId: string): Promise<BookSummary | null> {
    const [book] = await executor
      .select({
        id: books.id,
        name: books.name,
        baseCurrency: books.baseCurrency,
        createdAt: books.createdAt,
      })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);

    return book ?? null;
  }

  async insertApiKey(executor: Executor, key: NewApiKey): Promise<ApiKeyRecord> {
    const [inserted] = await executor.insert(apiKeys).values(key).returning(apiKeyColumns);
    if (inserted === undefined) throw new Error(`insert of api key ${key.id} returned no row`);
    return inserted;
  }

  /** Live means not revoked. Filtering in SQL keeps "revoked" from being a check a caller can forget. */
  async findLiveApiKeyByHash(executor: Executor, tokenHash: string): Promise<ApiKeyRecord | null> {
    const [key] = await executor
      .select(apiKeyColumns)
      .from(apiKeys)
      .where(and(eq(apiKeys.tokenHash, tokenHash), isNull(apiKeys.revokedAt)))
      .limit(1);

    return key ?? null;
  }

  /**
   * Advances `last_used_at` at most once per staleness window.
   *
   * The `WHERE` is what makes that true under concurrency: ten simultaneous requests with the
   * same key all issue this statement, and only the first finds a row to update. Without it,
   * a read-only endpoint would take a row lock on every single call, and every request using
   * one key would serialise behind the others for no benefit at all - the column answers "is
   * this key still in use", and minute resolution answers it perfectly well.
   */
  async touchApiKey(
    executor: Executor,
    apiKeyId: string,
    now: Date,
    staleAfterMs: number,
  ): Promise<boolean> {
    const threshold = new Date(now.getTime() - staleAfterMs);

    const touched = await executor
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.id, apiKeyId),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, threshold)),
        ),
      )
      .returning({ id: apiKeys.id });

    return touched.length > 0;
  }
}

/** The unique index behind `api_keys.token_hash`. Astronomically unlikely, checked anyway. */
export const API_KEY_HASH_CONSTRAINT = 'api_keys_token_hash_key';

