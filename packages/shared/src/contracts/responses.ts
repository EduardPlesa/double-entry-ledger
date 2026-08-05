import type { BookRole } from './roles.js';

/**
 * The shape of every JSON resource this API returns.
 *
 * Types, not schemas. A runtime parse at the client boundary would catch a server-side shape
 * change as an error instead of as `undefined` in a cell, and it would cost a schema per
 * resource and a parse per response against a server in this same repository, typechecked by
 * this same command. The field most likely to be wrong is validated either way: every amount
 * goes through `parseMoney`, which throws on anything that is not a decimal string.
 *
 * Three conventions hold throughout, and `serialize.ts` explains why: amounts are decimal
 * strings, posting ids are strings because a bigserial outruns `Number.MAX_SAFE_INTEGER`,
 * and timestamps are ISO 8601 with an offset.
 */

export interface BookResource {
  readonly id: string;
  readonly name: string;
  readonly baseCurrency: string;
  readonly createdAt: string;
  /**
   * The caller's role in this book. Present so the UI can stop offering what the policy
   * forbids - a viewer should not be shown a compose button that always ends in a 403. The
   * server still decides; this only lets the client stop asking.
   */
  readonly role: BookRole;
}

export interface AccountResource {
  readonly id: string;
  readonly bookId: string;
  readonly name: string;
  readonly type: string;
  readonly currency: string;
  /** Null for a root account. The tree the frontend draws is built from this column. */
  readonly parentId: string | null;
  readonly closedAt: string | null;
}

export interface EntryResource {
  readonly id: string;
  readonly bookId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly description: string;
  readonly externalId: string | null;
  readonly reversalOf: string | null;
  /**
   * The reversal of this entry, where one exists. The inverse of `reversalOf`, and the only
   * way a caller can know an entry is already reversed without attempting the reversal and
   * reading `ENTRY_ALREADY_REVERSED` off the failure.
   */
  readonly reversedBy: string | null;
  readonly postings: readonly {
    readonly id: string;
    readonly accountId: string;
    readonly amount: string;
    readonly currency: string;
  }[];
}

export interface BalanceResource {
  readonly accountId: string;
  readonly asOf: string | null;
  readonly balance: string;
  readonly currency: string;
}

export interface TrialBalanceResource {
  readonly bookId: string;
  readonly asOf: string | null;
  readonly accounts: readonly {
    readonly accountId: string;
    readonly name: string;
    readonly type: string;
    readonly currency: string;
    readonly balance: string;
  }[];
  readonly totals: readonly {
    readonly currency: string;
    readonly debits: string;
    readonly credits: string;
    readonly balanced: boolean;
  }[];
  readonly balanced: boolean;
}

export interface PostingPageResource {
  readonly accountId: string;
  readonly items: readonly {
    readonly id: string;
    readonly entryId: string;
    readonly occurredAt: string;
    readonly recordedAt: string;
    readonly description: string;
    readonly amount: string;
    readonly runningBalance: string;
    readonly currency: string;
  }[];
  readonly nextCursor: string | null;
}
