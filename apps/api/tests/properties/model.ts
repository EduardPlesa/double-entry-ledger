import type { AccountRecord } from '../../src/repositories/ledger.repository.js';

/**
 * What the ledger holds, according to everything the service accepted.
 *
 * The model **follows**. It records the outcome of a call that succeeded and records nothing
 * for one that was refused, and it contains no reimplementation of the overdraft rule. The
 * properties are therefore about the states the system can reach, not about the decisions it
 * makes getting there - which is what keeps the rule from existing a third time, after the SQL
 * in migration 0007 and the check in the service.
 *
 * No balance is stored as a mutable number. Balances are summed from `postings` when asked,
 * which is invariant 4 of this project applied to the test double as well as to the system.
 */

export interface ModelLeg {
  readonly accountId: string;
  readonly amountMinor: bigint;
}

export interface ModelPosting {
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly occurredAt: Date;
  /** Stands in for `postings.id`: monotone, and the prefix rule's tiebreaker. */
  readonly seq: number;
}

export interface ModelEntry {
  readonly id: string;
  readonly occurredAt: Date;
  readonly legs: readonly ModelLeg[];
  reversedBy: string | null;
}

export class LedgerModel {
  readonly accounts: readonly AccountRecord[];

  private readonly byId: ReadonlyMap<string, AccountRecord>;
  private readonly postings: ModelPosting[] = [];
  private readonly entries: ModelEntry[] = [];
  private nextSeq = 0;

  constructor(accounts: readonly AccountRecord[]) {
    this.accounts = accounts;
    this.byId = new Map(accounts.map((account) => [account.id, account]));
  }

  /** Records an entry the service accepted. Legs take consecutive `seq` values, as ids do. */
  record(entry: { id: string; occurredAt: Date; legs: readonly ModelLeg[] }): void {
    this.entries.push({
      id: entry.id,
      occurredAt: entry.occurredAt,
      legs: [...entry.legs],
      reversedBy: null,
    });

    for (const leg of entry.legs) {
      this.nextSeq += 1;
      this.postings.push({
        accountId: leg.accountId,
        amountMinor: leg.amountMinor,
        occurredAt: entry.occurredAt,
        seq: this.nextSeq,
      });
    }
  }

  markReversed(originalId: string, reversalId: string): void {
    const original = this.entries.find((entry) => entry.id === originalId);
    if (original === undefined) {
      throw new Error(`the model has no entry ${originalId} to mark reversed`);
    }
    original.reversedBy = reversalId;
  }

  balanceOf(accountId: string): bigint {
    let total = 0n;
    for (const posting of this.postings) {
      if (posting.accountId === accountId) total += posting.amountMinor;
    }
    return total;
  }

  /** The book's total per currency. Zero in every currency, or the ledger is broken. */
  totalsByCurrency(): Map<string, bigint> {
    const totals = new Map<string, bigint>();

    for (const posting of this.postings) {
      const account = this.byId.get(posting.accountId);
      if (account === undefined) continue;
      totals.set(account.currency, (totals.get(account.currency) ?? 0n) + posting.amountMinor);
    }

    return totals;
  }

  /** An account's postings in `(occurredAt, seq)` order - the order the prefix rule reads them in. */
  postingsOf(accountId: string): readonly ModelPosting[] {
    return this.postings
      .filter((posting) => posting.accountId === accountId)
      .sort((left, right) => {
        const byTime = left.occurredAt.getTime() - right.occurredAt.getTime();
        return byTime !== 0 ? byTime : left.seq - right.seq;
      });
  }

  /**
   * The lowest running balance the account ever reaches, and when.
   *
   * The same answer `lowestPrefixBalance` computes with a window function, arrived at by an
   * array scan instead. Ties on the running total are broken by `occurredAt` ascending,
   * matching that query's `order by running asc, occurred_at asc`.
   */
  lowestPrefix(accountId: string): { balanceMinor: bigint; occurredAt: Date } | null {
    const ordered = this.postingsOf(accountId);
    if (ordered.length === 0) return null;

    let running = 0n;
    let lowest: { balanceMinor: bigint; occurredAt: Date } | null = null;

    for (const posting of ordered) {
      running += posting.amountMinor;

      const better =
        lowest === null ||
        running < lowest.balanceMinor ||
        (running === lowest.balanceMinor && posting.occurredAt < lowest.occurredAt);

      if (better) lowest = { balanceMinor: running, occurredAt: posting.occurredAt };
    }

    return lowest;
  }

  /** Entries that have not been reversed. An entry may be reversed at most once. */
  reversibleEntries(): readonly ModelEntry[] {
    return this.entries.filter((entry) => entry.reversedBy === null);
  }

  entryCount(): number {
    return this.entries.length;
  }
}
