import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client.js';
import { refreshTokens, users } from '../db/schema.js';

/**
 * Users and refresh tokens.
 *
 * None of these tables is behind row-level security, and none of them can be: resolving who
 * the caller is has to happen before there is a book to scope anything to. They are reached
 * through the pooled executor rather than a book-scoped transaction for that reason.
 *
 * No business rules here. Whether presenting a redeemed token is theft or an unlucky double
 * click is a question about sessions, and it lives in the service; this module knows how to
 * write the row that the answer implies.
 */

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
}

export interface RefreshTokenRecord {
  readonly id: string;
  readonly familyId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly redeemedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly replacedBy: string | null;
}

export interface NewUser {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
}

export interface NewRefreshToken {
  readonly id: string;
  readonly familyId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface AuthRepository {
  insertUser(executor: Executor, user: NewUser): Promise<UserRecord>;
  findUserByEmail(executor: Executor, email: string): Promise<UserRecord | null>;
  findUserById(executor: Executor, userId: string): Promise<UserRecord | null>;

  insertRefreshToken(executor: Executor, token: NewRefreshToken): Promise<RefreshTokenRecord>;
  findRefreshTokenByHash(executor: Executor, tokenHash: string): Promise<RefreshTokenRecord | null>;

  /**
   * Marks a token redeemed, but only if it is live: unredeemed, unrevoked, unexpired.
   *
   * Returns the row it changed, or null if there was nothing to change. The check and the
   * write are one statement on purpose - a SELECT followed by an UPDATE would let two
   * concurrent refreshes both read an unredeemed token and both go on to issue a successor,
   * which is the exact race this whole mechanism exists to detect.
   */
  redeemRefreshToken(
    executor: Executor,
    tokenHash: string,
    now: Date,
  ): Promise<RefreshTokenRecord | null>;

  /** Records which token replaced this one, so the rotation chain is walkable. */
  linkReplacement(executor: Executor, tokenId: string, replacementId: string): Promise<void>;

  /** Revokes every live token in a family. Returns how many. */
  revokeFamily(executor: Executor, familyId: string, now: Date): Promise<number>;
}

const userColumns = {
  id: users.id,
  email: users.email,
  passwordHash: users.passwordHash,
  createdAt: users.createdAt,
};

const tokenColumns = {
  id: refreshTokens.id,
  familyId: refreshTokens.familyId,
  userId: refreshTokens.userId,
  tokenHash: refreshTokens.tokenHash,
  issuedAt: refreshTokens.issuedAt,
  expiresAt: refreshTokens.expiresAt,
  redeemedAt: refreshTokens.redeemedAt,
  revokedAt: refreshTokens.revokedAt,
  replacedBy: refreshTokens.replacedBy,
};

export class DrizzleAuthRepository implements AuthRepository {
  async insertUser(executor: Executor, user: NewUser): Promise<UserRecord> {
    const [inserted] = await executor.insert(users).values(user).returning(userColumns);
    if (inserted === undefined) throw new Error(`insert of user ${user.id} returned no row`);
    return inserted;
  }

  /**
   * Lookup by exact equality, which is only correct because the email was normalised before
   * it was stored - and the `users_email_normalised` CHECK is what makes that a fact about
   * the column rather than a habit of one method. A `lower(email) = lower($1)` here would
   * not use the unique index.
   */
  async findUserByEmail(executor: Executor, email: string): Promise<UserRecord | null> {
    const [user] = await executor.select(userColumns).from(users).where(eq(users.email, email)).limit(1);
    return user ?? null;
  }

  async findUserById(executor: Executor, userId: string): Promise<UserRecord | null> {
    const [user] = await executor.select(userColumns).from(users).where(eq(users.id, userId)).limit(1);
    return user ?? null;
  }

  async insertRefreshToken(executor: Executor, token: NewRefreshToken): Promise<RefreshTokenRecord> {
    const [inserted] = await executor.insert(refreshTokens).values(token).returning(tokenColumns);
    if (inserted === undefined) throw new Error(`insert of refresh token ${token.id} returned no row`);
    return inserted;
  }

  async findRefreshTokenByHash(
    executor: Executor,
    tokenHash: string,
  ): Promise<RefreshTokenRecord | null> {
    const [token] = await executor
      .select(tokenColumns)
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    return token ?? null;
  }

  async redeemRefreshToken(
    executor: Executor,
    tokenHash: string,
    now: Date,
  ): Promise<RefreshTokenRecord | null> {
    const [redeemed] = await executor
      .update(refreshTokens)
      .set({ redeemedAt: now })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          isNull(refreshTokens.redeemedAt),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, now),
        ),
      )
      .returning(tokenColumns);

    return redeemed ?? null;
  }

  async linkReplacement(executor: Executor, tokenId: string, replacementId: string): Promise<void> {
    await executor
      .update(refreshTokens)
      .set({ replacedBy: replacementId })
      .where(eq(refreshTokens.id, tokenId));
  }

  async revokeFamily(executor: Executor, familyId: string, now: Date): Promise<number> {
    const revoked = await executor
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });

    return revoked.length;
  }
}

/** The unique index behind `users.email`, so the service can spot the registration race. */
export const EMAIL_UNIQUE_CONSTRAINT = 'users_email_key';
