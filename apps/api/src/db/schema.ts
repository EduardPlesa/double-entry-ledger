import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The five account types of double-entry bookkeeping. A Postgres enum rather than
 * text + CHECK because this set is fixed by accounting itself, not by product
 * requirements - there will never be a sixth - so the usual objection to enums
 * (ALTER TYPE is awkward) never comes due.
 */
export const accountType = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
]);

export const books = pgTable(
  'books',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    baseCurrency: text('base_currency').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('books_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check('books_base_currency_iso4217', sql`${t.baseCurrency} ~ '^[A-Z]{3}$'`),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),
    name: text('name').notNull(),
    type: accountType('type').notNull(),
    currency: text('currency').notNull(),
    parentId: uuid('parent_id'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('accounts_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check('accounts_currency_iso4217', sql`${t.currency} ~ '^[A-Z]{3}$'`),

    // An account cannot be its own parent. This does not rule out longer cycles;
    // acyclicity of the tree is a service-layer concern, checked when a parent is
    // assigned. Recording it here would need a recursive trigger, which buys far less
    // than it costs.
    check('accounts_parent_not_self', sql`${t.parentId} is distinct from ${t.id}`),

    // Redundant against the primary key, but a composite foreign key can only target an
    // exactly-matching unique constraint. These two are the targets for the composite
    // keys below, which is how "a posting cannot reference an account in another book"
    // and "a posting cannot be denominated in a currency its account does not hold"
    // become facts the database enforces rather than rules the service remembers.
    unique('accounts_id_book_id_key').on(t.id, t.bookId),
    unique('accounts_id_book_id_currency_key').on(t.id, t.bookId, t.currency),

    // A parent account must live in the same book. parent_id is nullable and MATCH
    // SIMPLE is the default, so a null parent skips the check - which is exactly right
    // for a root account.
    foreignKey({
      name: 'accounts_parent_same_book_fk',
      columns: [t.parentId, t.bookId],
      foreignColumns: [t.id, t.bookId],
    }),
  ],
);

export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),

    // When the transaction happened in the world.
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    // When we learned about it. Distinct from occurred_at so backdated entries are
    // representable, which is what makes the id-keyed balance checkpoints of stage 7
    // necessary and the obvious date-keyed ones wrong.
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),

    description: text('description').notNull(),

    // Caller-supplied idempotency key, unique per book where present.
    externalId: text('external_id'),

    // Set when this entry reverses another. Corrections are new entries, never edits.
    reversalOf: uuid('reversal_of'),

    // No foreign keys yet: users and api_keys arrive in stage 3. Left nullable and
    // unconstrained rather than omitted, so the columns the audit trail needs exist
    // before any row is written to a table that can never be altered.
    createdByUserId: uuid('created_by_user_id'),
    createdByApiKeyId: uuid('created_by_api_key_id'),
  },
  (t) => [
    check('entries_description_not_blank', sql`length(btrim(${t.description})) > 0`),
    check('entries_external_id_not_blank', sql`${t.externalId} is null or length(btrim(${t.externalId})) > 0`),
    check('entries_reversal_not_self', sql`${t.reversalOf} is distinct from ${t.id}`),

    // Target for the composite keys on postings and on reversal_of.
    unique('entries_id_book_id_key').on(t.id, t.bookId),

    // Idempotency: at most one entry per (book, external_id), and no constraint at all
    // on the rows where external_id is null. A plain unique constraint would work too,
    // since Postgres treats nulls as distinct, but a partial index states the intent and
    // keeps the null rows out of the index entirely.
    uniqueIndex('entries_book_id_external_id_key')
      .on(t.bookId, t.externalId)
      .where(sql`${t.externalId} is not null`),

    // A reversal belongs to the same book as the entry it reverses.
    foreignKey({
      name: 'entries_reversal_same_book_fk',
      columns: [t.reversalOf, t.bookId],
      foreignColumns: [t.id, t.bookId],
    }),
  ],
);

export const postings = pgTable(
  'postings',
  {
    // bigserial, not uuid. Postings are the one table read in ranges rather than by
    // identity, and stage 7's balance checkpoints are keyed on this column precisely
    // because a monotonic integer gives "every posting after checkpoint X" a meaning
    // that a timestamp cannot.
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),

    entryId: uuid('entry_id').notNull(),

    // Denormalised from entries, and safe to denormalise because the composite foreign
    // key below makes disagreement with entries.book_id physically impossible. Present
    // so stage 3's row-level security policy is a column comparison instead of a
    // correlated subquery on the hottest read path in the system.
    bookId: uuid('book_id').notNull(),

    accountId: uuid('account_id').notNull(),

    // Minor units. bigint mode, so drizzle hands back a JS bigint and there is no code
    // path anywhere in which an amount is a number.
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),

    currency: text('currency').notNull(),
  },
  (t) => [
    check('postings_currency_iso4217', sql`${t.currency} ~ '^[A-Z]{3}$'`),

    // A zero-amount leg carries no information and no accounting meaning. Rejecting it
    // here keeps it out of a table nothing can ever clean up.
    check('postings_amount_nonzero', sql`${t.amountMinor} <> 0`),

    // Same book as the entry it belongs to.
    foreignKey({
      name: 'postings_entry_same_book_fk',
      columns: [t.entryId, t.bookId],
      foreignColumns: [entries.id, entries.bookId],
    }),

    // Same book *and* same currency as the account it posts to. One constraint, two
    // invariants: no cross-book postings, and no posting denominated in a currency its
    // account does not hold.
    foreignKey({
      name: 'postings_account_same_book_currency_fk',
      columns: [t.accountId, t.bookId, t.currency],
      foreignColumns: [accounts.id, accounts.bookId, accounts.currency],
    }),

    // Deliberately no index on (account_id, id) or on entry_id yet. Those are read-path
    // indexes, and stage 7 adds them with EXPLAIN ANALYZE either side to show what they
    // buy. Indexing a foreign key column is usually about making parent deletes cheap,
    // and in this schema nothing is ever deleted.
  ],
);
