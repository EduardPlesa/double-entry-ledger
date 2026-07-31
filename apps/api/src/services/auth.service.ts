import type { Clock } from '@ledger/shared';
import { z } from 'zod';
import type { Executor, UnitOfWork } from '../db/client.js';
import { isUniqueViolationOn } from '../db/pg-errors.js';
import type { PasswordHasher } from '../auth/password.js';
import type { AccessTokens, RefreshTokens } from '../auth/tokens.js';
import {
  EmailAlreadyRegisteredError,
  UnauthenticatedError,
  ValidationError,
} from '../domain/errors.js';
import {
  EMAIL_UNIQUE_CONSTRAINT,
  type AuthRepository,
  type RefreshTokenRecord,
  type UserRecord,
} from '../repositories/auth.repository.js';

/**
 * Registration, login, rotation and logout.
 *
 * The interesting part is `refresh`, and specifically what happens when a token that has
 * already been spent turns up again. Two explanations fit: the token was stolen and the
 * thief used it first, or it was stolen after the legitimate holder used it. From here those
 * are indistinguishable - and both mean somebody has a copy of a credential they should not.
 * So the response to either is the same: kill the whole family, forcing a real login, and
 * leave a revocation timestamp on every row so the incident is visible afterwards.
 *
 * The cost of that policy is real and worth stating: a client that fires two refreshes at
 * once - a double-clicked retry, two browser tabs waking together - loses its session. That
 * is the trade the stage brief asks for, and it is the right way round. A false positive
 * costs one login. A false negative costs the account.
 */

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'must be an email address');

/**
 * Twelve characters, and no composition rules.
 *
 * The upper bound is not a strength consideration - it is there because the password is fed
 * to a deliberately expensive hash, and an unbounded one lets a caller choose how much CPU
 * this process spends on their request.
 */
const passwordSchema = z.string().min(12, 'must be at least 12 characters').max(1024);

const credentialsSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export type CredentialsInput = z.input<typeof credentialsSchema>;

/** What a browser is told about itself, recorded on the token for the incident report. */
export interface SessionContext {
  readonly userAgent: string | null;
  readonly ip: string | null;
}

export interface SessionResult {
  readonly user: UserRecord;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  /** The plaintext refresh token. Goes into the cookie, is never stored, never logged. */
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export interface AuthServiceDependencies {
  readonly repository: AuthRepository;
  readonly unitOfWork: UnitOfWork;
  readonly passwordHasher: PasswordHasher;
  readonly accessTokens: AccessTokens;
  readonly refreshTokens: RefreshTokens;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly refreshTokenTtlSeconds: number;
}

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly unitOfWork: UnitOfWork;
  private readonly passwordHasher: PasswordHasher;
  private readonly accessTokens: AccessTokens;
  private readonly refreshTokenCodec: RefreshTokens;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly refreshTokenTtlSeconds: number;

  constructor(dependencies: AuthServiceDependencies) {
    this.repository = dependencies.repository;
    this.unitOfWork = dependencies.unitOfWork;
    this.passwordHasher = dependencies.passwordHasher;
    this.accessTokens = dependencies.accessTokens;
    this.refreshTokenCodec = dependencies.refreshTokens;
    this.clock = dependencies.clock;
    this.newId = dependencies.newId;
    this.refreshTokenTtlSeconds = dependencies.refreshTokenTtlSeconds;
  }

  /**
   * Creates a user and logs them straight in.
   *
   * The email is normalised here rather than trusted from the caller, which is what makes
   * the plain unique constraint on the column a real guarantee: `Alice@Example.COM` and
   * `alice@example.com` have to collide, and they only do if both were lowercased on the way
   * in. The `users_email_normalised` CHECK is the database refusing to hold anything else.
   */
  async register(input: CredentialsInput, context: SessionContext): Promise<SessionResult> {
    const { email, password } = parse(credentialsSchema, input);
    const passwordHash = await this.passwordHasher.hash(password);

    let user: UserRecord;
    try {
      user = await this.repository.insertUser(this.unitOfWork.executor, {
        id: this.newId(),
        email,
        passwordHash,
      });
    } catch (error) {
      if (isUniqueViolationOn(error, EMAIL_UNIQUE_CONSTRAINT)) {
        throw new EmailAlreadyRegisteredError(email);
      }
      throw error;
    }

    return this.startSession(user, context);
  }

  /**
   * Exchanges credentials for a session.
   *
   * An unknown email still runs a real argon2id verify - the hasher takes a nullable hash
   * for exactly this reason - so the time this takes does not answer "does this person have
   * an account here". And both failures produce the same error, so neither does the response.
   */
  async login(input: CredentialsInput, context: SessionContext): Promise<SessionResult> {
    const { email, password } = parse(credentialsSchema, input);
    const user = await this.repository.findUserByEmail(this.unitOfWork.executor, email);

    const correct = await this.passwordHasher.verify(user?.passwordHash ?? null, password);
    if (!correct || user === null) throw new UnauthenticatedError('email or password did not match');

    return this.startSession(user, context);
  }

  /**
   * Rotates a refresh token, or revokes the family that produced it.
   *
   * All in one transaction, because "this token is spent" and "here is its successor" have
   * to become true together. If the insert of the successor failed after the redemption
   * committed, the caller would hold a token the database considers used and no replacement -
   * a session that is neither alive nor cleanly dead.
   */
  async refresh(presentedToken: string, context: SessionContext): Promise<SessionResult> {
    const tokenHash = this.refreshTokenCodec.hash(presentedToken);
    const now = this.clock.now();

    const session = await this.unitOfWork.transaction(async (tx) => {
      // Compare-and-swap. Two simultaneous refreshes both reach this statement; the second
      // blocks on the row lock, and when it proceeds the row no longer matches, so exactly
      // one of them gets a token back. That is what makes the reuse branch below trustworthy
      // rather than a race of its own.
      const redeemed = await this.repository.redeemRefreshToken(tx, tokenHash, now);

      if (redeemed === null) {
        await this.rejectUnredeemable(tx, tokenHash, now);

        // Returns null rather than throwing, and that is not a style preference. Throwing
        // here would roll the transaction back - including the family revocation that
        // `rejectUnredeemable` has just written. Reuse detection would appear to work in
        // every unit test and quietly do nothing at all: the response would still be a 401,
        // and the stolen token would still be live. The rejection has to commit, so the
        // failure has to leave the transaction as a value.
        return null;
      }

      const user = await this.repository.findUserById(tx, redeemed.userId);

      // Not reachable through a foreign key that exists - but if it ever is, rolling back is
      // the right outcome, so this one does throw.
      if (user === null) throw new UnauthenticatedError('refresh token belongs to no user');

      const issued = await this.issueRefreshToken(tx, {
        familyId: redeemed.familyId,
        userId: user.id,
        now,
        context,
      });

      await this.repository.linkReplacement(tx, redeemed.id, issued.record.id);

      const access = await this.accessTokens.sign(user.id);

      return {
        user,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: issued.token,
        refreshTokenExpiresAt: issued.record.expiresAt,
      };
    });

    if (session === null) throw new UnauthenticatedError('refresh token was not redeemable');
    return session;
  }

  /**
   * Ends a session. Idempotent, and deliberately quiet.
   *
   * An unknown or already-dead token is not an error worth reporting: the caller asked to be
   * logged out and they are. Answering 401 to a logout would be the rare case of an endpoint
   * refusing to do the safe thing because the client was already in the safe state.
   */
  async logout(presentedToken: string | null): Promise<void> {
    if (presentedToken === null) return;

    const tokenHash = this.refreshTokenCodec.hash(presentedToken);
    const now = this.clock.now();

    await this.unitOfWork.transaction(async (tx) => {
      const token = await this.repository.findRefreshTokenByHash(tx, tokenHash);
      if (token === null) return;

      // The whole family, not just this token. Logging out on one device should not leave a
      // successor alive that the same cookie jar could still rotate.
      await this.repository.revokeFamily(tx, token.familyId, now);
    });
  }

  /**
   * Works out why a token could not be redeemed, and reacts to the one case that matters.
   *
   * Only reached on the failure path, so the extra read costs nothing on a normal refresh.
   */
  private async rejectUnredeemable(
    tx: Executor,
    tokenHash: string,
    now: Date,
  ): Promise<void> {
    const token = await this.repository.findRefreshTokenByHash(tx, tokenHash);

    // No such token. Nothing to revoke, and nothing to conclude: this is what a stale cookie
    // from a wiped database looks like as much as what a guess looks like.
    if (token === null) return;

    // Already revoked, or expired. Both are ordinary ends of a session.
    if (token.revokedAt !== null) return;
    if (token.expiresAt <= now) return;

    // Live, unexpired, and already redeemed. Somebody is presenting a token that was spent -
    // either the thief or the victim, and there is no way to tell which from here. Revoking
    // the family ends the session for both, which is the only outcome that does not leave an
    // attacker holding a working credential.
    if (token.redeemedAt !== null) {
      await this.repository.revokeFamily(tx, token.familyId, now);
    }
  }

  /** A brand new family: a login, rather than a rotation. */
  private async startSession(user: UserRecord, context: SessionContext): Promise<SessionResult> {
    const now = this.clock.now();

    const issued = await this.issueRefreshToken(this.unitOfWork.executor, {
      familyId: this.newId(),
      userId: user.id,
      now,
      context,
    });

    const access = await this.accessTokens.sign(user.id);

    return {
      user,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: issued.token,
      refreshTokenExpiresAt: issued.record.expiresAt,
    };
  }

  private async issueRefreshToken(
    executor: Executor,
    input: { familyId: string; userId: string; now: Date; context: SessionContext },
  ): Promise<{ token: string; record: RefreshTokenRecord }> {
    const { token, tokenHash } = this.refreshTokenCodec.generate();

    const record = await this.repository.insertRefreshToken(executor, {
      id: this.newId(),
      familyId: input.familyId,
      userId: input.userId,
      tokenHash,
      issuedAt: input.now,
      expiresAt: new Date(input.now.getTime() + this.refreshTokenTtlSeconds * 1000),
      userAgent: input.context.userAgent,
      ip: input.context.ip,
    });

    return { token, record };
  }
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new ValidationError(
    `invalid credentials: ${z.prettifyError(result.error)}`,
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
    { cause: result.error },
  );
}
