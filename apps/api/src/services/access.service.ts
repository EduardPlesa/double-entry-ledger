import type { Clock } from '@ledger/shared';
import type { AccessTokens } from '../auth/tokens.js';
import { hashApiKey, looksLikeApiKey } from '../auth/tokens.js';
import type { UnitOfWork } from '../db/client.js';
import {
  AccountNotFoundError,
  BookNotFoundError,
  EntryNotFoundError,
  ForbiddenError,
  UnauthenticatedError,
} from '../domain/errors.js';
import { can, type Permission } from '../domain/policy.js';
import type { BookAccess, Principal } from '../http/context.js';
import type { MembershipRepository } from '../repositories/membership.repository.js';
import type { LedgerRepository } from '../repositories/ledger.repository.js';
import type { BookSource } from '../routes/registry.js';

/**
 * Who is calling, which book they are asking about, and whether they may.
 *
 * Three questions, one service, so that the middleware above it is a thin adapter and the
 * answers can be tested without an HTTP request. The policy map is consulted here and
 * nowhere else outside its own module.
 *
 * The distinction the whole thing turns on: not being a member of a book produces a 404, not
 * a 403. A 403 confirms the book exists and that the caller is simply not allowed - which
 * makes membership enumerable by anyone holding an id. 403 is reserved for a caller who *is*
 * a member and whose role is not enough, where there is nothing left to conceal.
 */

/** How stale `last_used_at` must be before a request pays to advance it. */
const API_KEY_TOUCH_INTERVAL_MS = 60_000;

export interface AccessServiceDependencies {
  readonly membershipRepository: MembershipRepository;
  readonly ledgerRepository: LedgerRepository;
  readonly unitOfWork: UnitOfWork;
  readonly accessTokens: AccessTokens;
  readonly clock: Clock;
}

export class AccessService {
  private readonly membershipRepository: MembershipRepository;
  private readonly ledgerRepository: LedgerRepository;
  private readonly unitOfWork: UnitOfWork;
  private readonly accessTokens: AccessTokens;
  private readonly clock: Clock;

  constructor(dependencies: AccessServiceDependencies) {
    this.membershipRepository = dependencies.membershipRepository;
    this.ledgerRepository = dependencies.ledgerRepository;
    this.unitOfWork = dependencies.unitOfWork;
    this.accessTokens = dependencies.accessTokens;
    this.clock = dependencies.clock;
  }

  /**
   * Turns an `Authorization: Bearer ...` value into a principal.
   *
   * Both credential types arrive on the same header, told apart by the `lk_` prefix rather
   * than by trying one and falling back to the other. Falling back would mean a failed JWT
   * verification silently becoming a database lookup, which is both slower and a way for the
   * two paths' error handling to drift apart.
   */
  async authenticate(authorization: string | undefined): Promise<Principal> {
    const credential = bearerOf(authorization);
    if (credential === null) throw new UnauthenticatedError('no bearer credential was presented');

    return looksLikeApiKey(credential)
      ? this.authenticateApiKey(credential)
      : this.authenticateAccessToken(credential);
  }

  private async authenticateAccessToken(token: string): Promise<Principal> {
    const claims = await this.accessTokens.verify(token);
    if (claims === null) throw new UnauthenticatedError('access token did not verify');

    // Deliberately no lookup to confirm the user still exists. That is what a ten-minute
    // lifetime buys: the token is the assertion, and the window in which a deleted user could
    // still act is bounded and short. A lookup here would put a query on every single request
    // to defend against something this system cannot even do - there is no user deletion.
    return { kind: 'user', userId: claims.subject };
  }

  private async authenticateApiKey(key: string): Promise<Principal> {
    const record = await this.membershipRepository.findLiveApiKeyByHash(
      this.unitOfWork.executor,
      hashApiKey(key),
    );

    if (record === null) throw new UnauthenticatedError('api key is unknown or revoked');

    // Not awaited into the request's critical path any more than it has to be, but not
    // fire-and-forget either: an unhandled rejection here would take the process down, and
    // the repository already throttles this to one write a minute per key.
    await this.membershipRepository.touchApiKey(
      this.unitOfWork.executor,
      record.id,
      this.clock.now(),
      API_KEY_TOUCH_INTERVAL_MS,
    );

    return { kind: 'apiKey', apiKeyId: record.id, bookId: record.bookId, role: record.role };
  }

  /**
   * Finds the book a request is about.
   *
   * For `param` it is in the path. For the other two it has to be looked up, and the lookup
   * goes through the SECURITY DEFINER functions from migration 0006 - because reading
   * `accounts` to find its book is itself behind a policy keyed on that book.
   *
   * A missing id and an id in another book produce the same not-found error, which is the
   * point: the caller learns nothing they could not have guessed.
   */
  async resolveBookId(source: BookSource, id: string): Promise<string> {
    if (source === 'param') return id;

    const executor = this.unitOfWork.executor;

    if (source === 'account') {
      const bookId = await this.ledgerRepository.bookOfAccount(executor, id);
      if (bookId === null) throw new AccountNotFoundError([id]);
      return bookId;
    }

    const bookId = await this.ledgerRepository.bookOfEntry(executor, id);
    if (bookId === null) throw new EntryNotFoundError(id);
    return bookId;
  }

  /**
   * The authorization decision.
   *
   * An API key is scoped to one book and carries its own role, so there is no membership to
   * look up - and a key presented against a different book is treated exactly like a
   * non-member, for the same reason.
   */
  async authorize(principal: Principal, bookId: string, permission: Permission): Promise<BookAccess> {
    const role = await this.roleIn(principal, bookId);

    // Not a member. A 404, so that membership cannot be probed with an id and a stopwatch.
    if (role === null) throw new BookNotFoundError(bookId);

    // A member, and the role is not enough. Nothing left to conceal, so this one is honest.
    if (!can(role, permission)) throw new ForbiddenError(permission, role);

    return { bookId, role };
  }

  private async roleIn(principal: Principal, bookId: string): Promise<BookAccess['role'] | null> {
    if (principal.kind === 'apiKey') {
      return principal.bookId === bookId ? principal.role : null;
    }

    const membership = await this.membershipRepository.findMembership(
      this.unitOfWork.executor,
      bookId,
      principal.userId,
    );

    return membership?.role ?? null;
  }
}

/**
 * The credential out of an `Authorization` header.
 *
 * The scheme is matched case-insensitively because RFC 9110 says it is case-insensitive, and
 * clients that send `bearer` exist.
 */
function bearerOf(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;

  const match = /^Bearer +(.+)$/i.exec(authorization.trim());
  const credential = match?.[1]?.trim();

  return credential === undefined || credential === '' ? null : credential;
}
