import { formatMoney, type Money } from '@ledger/shared';
import type { EntryRecord } from '../repositories/ledger.repository.js';
import type { BalanceResult, PostingPage } from '../services/ledger.service.js';

/**
 * Domain values into JSON.
 *
 * Explicit functions, not a global `BigInt.prototype.toJSON` and not a replacer passed to
 * `JSON.stringify`. Both of those work, and both mean that every bigint anywhere in the
 * process silently acquires a serialisation - including ones that should never have reached
 * a response at all. A serializer per resource makes the response shape a thing you can read
 * in one place, and makes adding a field to it a deliberate act.
 *
 * Three rules, all of them the same rule:
 *
 *   amounts       decimal strings, via formatMoney. Never JSON numbers: a JSON number is an
 *                 IEEE 754 double, and a ledger that cannot round-trip its own values
 *                 through its own API is not one you would put money in.
 *   posting ids   strings. bigserial outruns Number.MAX_SAFE_INTEGER eventually, and a
 *                 JavaScript client would round it without noticing.
 *   timestamps    ISO 8601 with an offset, never a locale-dependent format.
 */

function amount(value: Money): string {
  return formatMoney(value);
}

export interface EntryResource {
  readonly id: string;
  readonly bookId: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly description: string;
  readonly externalId: string | null;
  readonly reversalOf: string | null;
  readonly postings: readonly {
    readonly id: string;
    readonly accountId: string;
    readonly amount: string;
    readonly currency: string;
  }[];
}

export function serializeEntry(entry: EntryRecord): EntryResource {
  return {
    id: entry.id,
    bookId: entry.bookId,
    occurredAt: entry.occurredAt.toISOString(),
    recordedAt: entry.recordedAt.toISOString(),
    description: entry.description,
    externalId: entry.externalId,
    reversalOf: entry.reversalOf,
    postings: entry.postings.map((posting) => ({
      id: posting.id.toString(),
      accountId: posting.accountId,

      // The raw minor-unit amount is deliberately not exposed alongside this. Two
      // representations of one number is two things a client can disagree about, and the
      // decimal string is the one the API boundary is defined in.
      amount: formatMoney({ amountMinor: posting.amountMinor, currency: posting.currency }),
      currency: posting.currency,
    })),
  };
}

export interface BalanceResource {
  readonly accountId: string;
  readonly asOf: string | null;
  readonly balance: string;
  readonly currency: string;
}

export function serializeBalance(result: BalanceResult): BalanceResource {
  return {
    accountId: result.accountId,
    asOf: result.asOf?.toISOString() ?? null,
    balance: amount(result.balance),
    currency: result.balance.currency,
  };
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

export function serializePostingPage(page: PostingPage): PostingPageResource {
  return {
    accountId: page.accountId,
    items: page.items.map((item) => ({
      id: item.id.toString(),
      entryId: item.entryId,
      occurredAt: item.occurredAt.toISOString(),
      recordedAt: item.recordedAt.toISOString(),
      description: item.description,
      amount: amount(item.amount),
      runningBalance: amount(item.runningBalance),
      currency: item.amount.currency,
    })),
    nextCursor: page.nextCursor,
  };
}
