import { formatMoney, money } from '@ledger/shared';
import type { Pool } from 'pg';
import { DrizzleUnitOfWork, createDatabase, type UnitOfWork } from '../../src/db/client.js';
import { isGuardedAccountType } from '../../src/domain/overdraft.js';
import type { AccountRecord, EntryRecord } from '../../src/repositories/ledger.repository.js';
import type { LedgerService } from '../../src/services/ledger.service.js';
import { accountsOf, seedBookIn } from '../helpers/ledger.js';
import { createService } from '../helpers/service.js';
import { LedgerModel } from './model.js';

/**
 * A funded book, one per generated case.
 *
 * Funded because an empty book exercises one branch of the overdraft rule and nothing else:
 * every withdrawal from a zero balance is refused, the coverage guard fires, and the sequence
 * proves nothing. Every guarded account opens with €160.00 - or its currency's equivalent -
 * dated before any generated entry, so history is well-founded before anything draws on it.
 *
 * A fresh book per case rather than a shared one, because this database has no teardown by
 * design: entries and postings cannot be deleted. Isolation is disjointness.
 */

/**
 * Measured, not derived: at 100 000 a run of 1000 generated cases posted 3249 entries and
 * refused none - a dozen legs each at most ±`MAX_LEG_MINOR` (20 000) is a random walk whose
 * standard deviation lands around 30 000, so reaching -100 000 was a 3-4 sigma tail that
 * essentially never happened, and the coverage guard on `tally.refused` never had anything to
 * find.
 *
 * 30 000 was tried next and measured over ten full runs: 649 attempts total, only 42 refused
 * (~6.5%, a mean of ~4.2 refusals per run). The guard's `tally.refused > 0` assertion held on
 * all ten, but `P(0 refusals in one run) ≈ (1 − 0.065)^65 ≈ 1.3%` - ten samples has roughly an
 * 87% chance of missing an event that rare, so ten green runs did not bound the risk of a
 * spurious red one.
 *
 * 16 000 is what replaced it, chosen so the *mean* refusal count clears the Poisson zero-tail
 * rather than merely being observed non-zero. Measured over ten full runs at this value: 668
 * attempts total, 160 refused (508 accepted), a mean of 16.0 refusals per run and a minimum of
 * 10 in any single run - `P(0) ≈ e^-16`, far below the ~0.005% target. Acceptances stayed the
 * clear majority throughout (76% overall, and strictly greater than refusals in every one of
 * the ten runs, by margins no tighter than roughly 2:1). See `task-5-report.md` for the full
 * per-run counts.
 */
export const OPENING_MINOR = 16_000n;
export const OPENING_AT = '2026-01-01T00:00:00.000Z';

export interface PropertyBook {
  readonly bookId: string;
  readonly accounts: readonly AccountRecord[];
  readonly service: LedgerService;
  /**
   * Read-only here: the prefix cross-check in `prefix.ts` needs a book-scoped transaction to
   * reach `lowestPrefixBalance`, and nothing else uses it.
   */
  readonly unitOfWork: UnitOfWork;
  /**
   * A fresh {@link LedgerModel}, pre-loaded with the opening entries this fixture already
   * posted through the real service.
   *
   * A model that starts empty is wrong the moment it's compared against this database: the
   * database holds one opening entry per currency and the model holds none, so every balance
   * the model reports is off by exactly `OPENING_MINOR` per guarded account. This fixture is
   * the only thing that knows those entries exist - it posted them - so it is what constructs
   * a model that agrees with the database from the start, rather than leaving each caller to
   * reconstruct that knowledge (and risk reconstructing it wrong).
   *
   * A factory rather than a shared instance: every generated case gets its own book and must
   * get its own model, or state from one case would leak into the next through a model that
   * outlives it.
   */
  newModel(): LedgerModel;
}

export async function createPropertyBook(pool: Pool): Promise<PropertyBook> {
  const { service } = createService(pool);
  // The same shape `createService` builds internally. Read-only here: the cross-check needs a
  // book-scoped transaction to reach `lowestPrefixBalance`, and nothing else uses it.
  const unitOfWork = new DrizzleUnitOfWork(createDatabase(pool));
  const book = await seedBookIn(pool);
  const records = accountsOf(book);
  const openingEntries: EntryRecord[] = [];

  // One opening entry per currency: every guarded account in it funded, the counterpart on an
  // unguarded account of the same currency so the entry balances without going short.
  const currencies = [...new Set(records.map((account) => account.currency))].sort();

  for (const currency of currencies) {
    const inCurrency = records.filter((account) => account.currency === currency);
    const guarded = inCurrency.filter((account) => isGuardedAccountType(account.type));
    const counterpart = inCurrency.find((account) => !isGuardedAccountType(account.type));

    if (guarded.length === 0 || counterpart === undefined) continue;

    const { entry } = await service.postEntry(book.bookId, {
      occurredAt: OPENING_AT,
      description: `opening balance ${currency}`,
      legs: [
        ...guarded.map((account) => ({
          accountId: account.id,
          amount: formatMoney(money(OPENING_MINOR, currency)),
          currency,
        })),
        {
          accountId: counterpart.id,
          amount: formatMoney(money(-OPENING_MINOR * BigInt(guarded.length), currency)),
          currency,
        },
      ],
    });

    openingEntries.push(entry);
  }

  return {
    bookId: book.bookId,
    accounts: records,
    service,
    unitOfWork,
    newModel(): LedgerModel {
      const model = new LedgerModel(records);
      for (const entry of openingEntries) {
        model.record({
          id: entry.id,
          occurredAt: entry.occurredAt,
          legs: entry.postings.map((posting) => ({
            accountId: posting.accountId,
            amountMinor: posting.amountMinor,
          })),
        });
      }
      return model;
    },
  };
}
