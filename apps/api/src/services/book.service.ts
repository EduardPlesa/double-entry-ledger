import {
  createBookInput as createBookSchema,
  type BookResource,
  type Clock,
  type CreateBookInput,
} from '@ledger/shared';
import { z } from 'zod';
import { generateApiKey } from '../auth/tokens.js';
import type { ApiKeyEnvironment } from '../config.js';
import type { UnitOfWork } from '../db/client.js';
import { UserNotFoundError, ValidationError } from '../domain/errors.js';
import { BOOK_ROLES } from '../domain/policy.js';
import type { Principal } from '../http/context.js';
import type { AuthRepository } from '../repositories/auth.repository.js';
import type { BookRecord, LedgerRepository } from '../repositories/ledger.repository.js';
import type {
  ApiKeyRecord,
  BookMembershipRecord,
  MembershipRepository,
} from '../repositories/membership.repository.js';

/**
 * Books, their members, and the keys machines use to reach them.
 *
 * Two repositories, deliberately. Creating a book and making its creator the owner is one
 * fact, not two - a book with no owner is a book nobody can ever administer, and it cannot be
 * fixed afterwards because fixing it would itself need `member:manage` in that book. So both
 * writes go in one transaction, and the service that spans them is the right place for it.
 */

export type { CreateBookInput };

export const grantRoleSchema = z.object({
  /**
   * By email rather than by user id. A caller adding a colleague knows their address and has
   * no way to discover their id - and an endpoint that accepted ids would be an endpoint that
   * confirms which ids exist.
   */
  email: z.string().trim().toLowerCase().min(3).max(320),
  role: z.enum(BOOK_ROLES),
});

export type GrantRoleInput = z.input<typeof grantRoleSchema>;

export const issueApiKeySchema = z.object({
  name: z.string().trim().min(1, 'must not be blank').max(200),
  role: z.enum(BOOK_ROLES),
});

export type IssueApiKeyInput = z.input<typeof issueApiKeySchema>;

export interface IssuedApiKey {
  readonly key: ApiKeyRecord;
  /** The plaintext, returned once and never recoverable. Not stored, not logged. */
  readonly token: string;
}

export interface BookServiceDependencies {
  readonly ledgerRepository: LedgerRepository;
  readonly membershipRepository: MembershipRepository;
  readonly authRepository: AuthRepository;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly apiKeyEnvironment: ApiKeyEnvironment;
}

export class BookService {
  private readonly ledgerRepository: LedgerRepository;
  private readonly membershipRepository: MembershipRepository;
  private readonly authRepository: AuthRepository;
  private readonly unitOfWork: UnitOfWork;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly apiKeyEnvironment: ApiKeyEnvironment;

  constructor(dependencies: BookServiceDependencies) {
    this.ledgerRepository = dependencies.ledgerRepository;
    this.membershipRepository = dependencies.membershipRepository;
    this.authRepository = dependencies.authRepository;
    this.unitOfWork = dependencies.unitOfWork;
    this.clock = dependencies.clock;
    this.newId = dependencies.newId;
    this.apiKeyEnvironment = dependencies.apiKeyEnvironment;
  }

  /** Creates a book and makes its creator the owner, atomically. */
  async createBook(ownerUserId: string, input: CreateBookInput): Promise<BookRecord> {
    const parsed = parse(createBookSchema, input, 'book');

    return this.unitOfWork.transaction(async (tx) => {
      const book = await this.ledgerRepository.insertBook(tx, {
        id: this.newId(),
        name: parsed.name,
        baseCurrency: parsed.baseCurrency,
        createdAt: this.clock.now(),
      });

      await this.membershipRepository.grantRole(tx, book.id, ownerUserId, 'owner');

      return book;
    });
  }

  /**
   * Adds a member, or changes an existing member's role.
   *
   * Including the caller's own. Demoting yourself out of `member:manage` is permitted and
   * deliberately not guarded against: the alternative is a rule about the last owner that has
   * to be enforced under concurrency, and this system has no delete, so an owner who demotes
   * themselves has locked a book rather than destroyed one. Worth saying out loud in
   * docs/limitations.md at stage 7 rather than pretending it cannot happen.
   */
  async grantRole(bookId: string, input: GrantRoleInput) {
    const parsed = parse(grantRoleSchema, input, 'membership');

    const user = await this.authRepository.findUserByEmail(this.unitOfWork.executor, parsed.email);

    // 404 rather than a quiet success. An invitation flow for people who have not registered
    // is a feature this stage does not have, and pretending to grant a role to nobody would
    // be worse than saying so.
    if (user === null) throw new UserNotFoundError(parsed.email);

    const membership = await this.membershipRepository.grantRole(
      this.unitOfWork.executor,
      bookId,
      user.id,
      parsed.role,
    );

    return { membership, user };
  }

  /**
   * Mints a key for one book with one role.
   *
   * Narrower than a user by design: a user may belong to many books, a key never does. A key
   * lives in someone's CI configuration, and the blast radius of losing one should be a
   * single book.
   */
  async issueApiKey(
    bookId: string,
    input: IssueApiKeyInput,
    issuedBy: Principal,
  ): Promise<IssuedApiKey> {
    const parsed = parse(issueApiKeySchema, input, 'api key');
    const generated = generateApiKey(this.apiKeyEnvironment);

    const key = await this.membershipRepository.insertApiKey(this.unitOfWork.executor, {
      id: this.newId(),
      bookId,
      role: parsed.role,
      tokenHash: generated.tokenHash,
      prefix: generated.prefix,
      name: parsed.name,

      // A key issued by another key records no user, which is honest rather than a gap: the
      // audit trail says a machine did it, because a machine did.
      createdByUserId: issuedBy.kind === 'user' ? issuedBy.userId : null,
    });

    return { key, token: generated.token };
  }

  /**
   * Every book this caller can reach, and what they may do in it.
   *
   * A user may belong to many books; an API key is scoped to exactly one, which is why the
   * two principals take different paths to the same answer rather than one query with a
   * branch inside it. Neither table is behind row-level security, so this runs in a plain
   * transaction: there is no book context to be inside of before the caller has been told
   * which books exist.
   */
  async listBooks(principal: Principal): Promise<BookResource[]> {
    return this.unitOfWork.transaction(async (tx) => {
      if (principal.kind === 'user') {
        const rows = await this.membershipRepository.listBooksForUser(tx, principal.userId);
        return rows.map(toBookResource);
      }

      const book = await this.membershipRepository.findBookById(tx, principal.bookId);
      return book === null ? [] : [toBookResource({ ...book, role: principal.role })];
    });
  }
}

/**
 * A `BookRecord` plus the caller's role in it, shaped into the resource every read of a book
 * returns - including the one `POST /books` hands back for the book it just created, whose
 * creator is always its owner.
 */
export function toBookResource(record: BookMembershipRecord): BookResource {
  return {
    id: record.id,
    name: record.name,
    baseCurrency: record.baseCurrency,
    createdAt: record.createdAt.toISOString(),
    role: record.role,
  };
}

function parse<T extends z.ZodType>(schema: T, input: unknown, subject: string): z.output<T> {
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
