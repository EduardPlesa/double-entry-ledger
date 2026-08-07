import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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

    // Who recorded it. Exactly one of these is set for an entry written through the API -
    // a session or a machine client - and both are null for the rows stage 1 and 2 wrote
    // before either table existed. Nullable rather than a CHECK demanding one, because
    // history cannot be backfilled: the immutability trigger means a row written without
    // an author stays without one forever.
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdByApiKeyId: uuid('created_by_api_key_id').references(() => apiKeys.id),
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

    // Stage 7 measured this rather than assuming it. `postings(account_id, id)` is not
    // primarily a read-path index; its hottest consumer is the overdraft prefix scan
    // (`lowestPrefixBalance`), which runs inside the entry-insert critical section with the
    // account's row lock held, and then again in the deferred LG004 trigger at COMMIT.
    // `computeCheckpoint`'s refresh scan (`scripts/checkpoint.ts`) runs under the same lock,
    // over the same column, for the same reason. On the 500k-posting perf corpus
    // (`docs/performance.md`), with this index: `lowest-prefix`'s account-filtered scan
    // dropped from a Parallel Seq Scan over all 500,000 postings (16,207 buffers) to an
    // Index Scan touching only the account's own rows (5,692 buffers); the checkpoint delta
    // sum dropped from 4,247 buffers/15.1ms to 3 buffers/0.04ms; `balance-from-zero` dropped
    // from 13,678 to 10,018 buffers; `postings-page`'s cursor scan moved off `postings_pkey`
    // onto this index directly. `lowest-prefix`'s buffer count fell but its wall-clock time
    // did not - the cheaper postings scan made the planner switch its join with `entries`
    // from an indexed nested loop to a parallel hash join with a full scan of `entries`,
    // and that trade lost: 21.4ms baseline to 55.7ms indexed, reproduced across repeated
    // captures. The index still ships, because three of the four queries it touches improved
    // and the fourth's regression is a join-order choice the planner made, not a cost this
    // index itself imposes - but it is not the unqualified win the other three numbers are,
    // and docs/performance.md says so.
    //
    // `postings(entry_id)` was measured alongside it and dropped. Indexing a foreign key
    // column is usually about making parent deletes cheap, and nothing in this schema is
    // ever deleted; without that, nothing here reads `postings` by `entry_id` either - every
    // join to `entries` looks up `entries`'s own primary key from a `postings` row already in
    // hand, never the reverse - and across all five queries' `EXPLAIN (ANALYZE, BUFFERS)`
    // output, on both a fresh capture and a repeat, no plan ever named it. An index nobody
    // measured a use for is a permanent write cost with a story attached; this one's story
    // didn't hold up, so it isn't here. The null result is in docs/performance.md.
    index('postings_account_id_id_idx').on(t.accountId, t.id),
  ],
);

/**
 * A balance, and the posting it was true through.
 *
 * `through_id` and not a date, and the difference is the whole reason this table exists. A
 * checkpoint asserts the sum over postings with `id <= through_id`. `postings.id` is a
 * bigserial assigned at insert, so an entry backdated in `occurred_at` still receives ids
 * above everything already stored: no later-recorded entry can retroactively enter the set
 * this row summed just by describing an earlier time. That argument is about backdating and
 * it still holds - see docs/adr/0005-balance-checkpoints.md - but it is not, on its own, the
 * reason the set is frozen.
 *
 * The actual reason is a lock, not a property of `postings.id` alone. `nextval()` fires at
 * INSERT time, not at COMMIT, and is not transactional, so a posting can draw an id below a
 * watermark while its transaction is still open - and if that transaction commits after the
 * checkpoint is written, its posting sits below `through_id` forever with nothing having
 * summed it. Two designs that tried to make `computeCheckpoint`'s single read safe against
 * this on its own - filtering by each posting's `xmin` against a snapshot boundary, and
 * draining every transaction a snapshot's `xip_list` named before recomputing - were each
 * disproved with a reproducible counter-example; see
 * `docs/adr/0005-balance-checkpoints.md`. What actually
 * freezes the set is `LedgerService.checkpointAccount` holding the account's `FOR NO KEY
 * UPDATE` lock - the same one `postEntry`/`reverseEntry` take - for the duration of the read:
 * with it held, no posting for this account can be mid-insert, so the row this method computes
 * really is final the moment it is written. `checkpointAccount`'s own comment is the
 * authoritative statement of what this depends on and why it only holds under the `row-lock`
 * concurrency strategy - it refuses to run under `serializable` rather than write a row that
 * carried no such guarantee.
 *
 * A checkpoint keyed on `occurred_at <= D` would assert a sum over a set that is *not*
 * frozen even with the lock, for a different reason: an entry recorded tomorrow, describing
 * last March, lands inside it - and the stored number is then wrong with nothing in the row to
 * say so. Invalidating it correctly means comparing every entry's `recorded_at` against every
 * checkpoint's date, which is bitemporal bookkeeping and a different system.
 *
 * The same asymmetry bounds what this can accelerate: `asOf` balances and the trial balance
 * filter on `occurred_at`, and `lowestPrefixBalance` is a minimum over prefixes that a
 * backdated entry rewrites behind any watermark. None of those can resume from here.
 */
export const balanceCheckpoints = pgTable(
  'balance_checkpoints',
  {
    accountId: uuid('account_id').notNull(),

    // Denormalised from accounts, exactly as postings.book_id is, and for the same reason:
    // the policy stays a column comparison, and the composite foreign key below makes
    // disagreement impossible.
    bookId: uuid('book_id').notNull(),

    throughId: bigint('through_id', { mode: 'bigint' }).notNull(),
    balanceMinor: bigint('balance_minor', { mode: 'bigint' }).notNull(),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Also the index the read uses: "the latest checkpoint for this account" is a backwards
    // scan of this key, so no secondary index is needed.
    primaryKey({ name: 'balance_checkpoints_pkey', columns: [t.accountId, t.throughId] }),

    foreignKey({
      name: 'balance_checkpoints_account_same_book_fk',
      columns: [t.accountId, t.bookId],
      foreignColumns: [accounts.id, accounts.bookId],
    }),

    // A watermark of zero would be a claim about no postings at all, which the empty sum
    // already answers for free.
    check('balance_checkpoints_through_id_positive', sql`${t.throughId} > 0`),
  ],
);

/**
 * The three per-book roles. An enum for the same reason `account_type` is one: the set is
 * fixed by the policy map in `domain/policy.ts`, and a role the database accepts but the
 * policy map has never heard of would authorise nothing while looking like it authorises
 * something. Adding a fourth role means editing both, which is the intended friction.
 */
export const bookRole = pgEnum('book_role', ['owner', 'accountant', 'viewer']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),

    // Normalised - trimmed and lowercased - before it ever reaches here, so that the plain
    // unique constraint below is a real guarantee rather than one a differently-cased
    // duplicate walks straight past. The CHECK is what makes "normalised" a fact about the
    // column instead of a habit of one service method.
    email: text('email').notNull(),

    // argon2id, encoded in PHC string format, which carries its own parameters. That is
    // what makes the cost factors changeable later without invalidating existing hashes:
    // each row records how it was hashed.
    passwordHash: text('password_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    unique('users_email_key').on(t.email),
    check('users_email_normalised', sql`${t.email} = lower(btrim(${t.email}))`),

    // Deliberately shallow. An email address is validated by sending mail to it, not by a
    // regular expression; this rejects only the shapes that are certainly mistakes.
    check('users_email_shape', sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`),
  ],
);

/**
 * Refresh tokens, as a rotation chain rather than a current value.
 *
 * Every token belongs to a family, and a family is one login session. Rotation redeems the
 * presented token and issues a successor in the same family, so the table accumulates the
 * whole history of a session rather than overwriting it.
 *
 * That history is the feature. Presenting a token that has already been redeemed means
 * either the token was stolen and the thief got there first, or it was stolen after the
 * legitimate holder used it - and from the server's side those are indistinguishable. The
 * only safe response is to revoke the entire family, which is one UPDATE precisely because
 * the family id is a column here.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),

    // Constant for the life of a session. Not a foreign key to a sessions table: there is
    // no sessions table, because nothing yet asks a question about a session that this
    // column cannot answer.
    familyId: uuid('family_id').notNull(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),

    // HMAC-SHA256 under a pepper held only in the application's configuration, hex encoded.
    // Not argon2: the token is 256 bits of CSPRNG output, so there is no dictionary to
    // mount and no reason to pay a deliberately slow hash on every refresh. The pepper is
    // what stops a leaked table alone from yielding usable tokens.
    tokenHash: text('token_hash').notNull(),

    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    /** Set the moment this token is exchanged. A second exchange is the reuse signal. */
    redeemedAt: timestamp('redeemed_at', { withTimezone: true, mode: 'date' }),

    /** Set on logout, and on every token in a family when reuse is detected. */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),

    /** The successor issued when this token was redeemed. Makes the chain walkable. */
    replacedBy: uuid('replaced_by'),

    // Recorded for the incident, not for the decision: nothing authenticates on these, and
    // an audit trail that says only "a token was reused" answers no question worth asking.
    // Text rather than inet because the value arrives from a proxy header and a malformed
    // one must not be able to fail the insert that is trying to record it.
    userAgent: text('user_agent'),
    ip: text('ip'),
  },
  (t) => [
    unique('refresh_tokens_token_hash_key').on(t.tokenHash),

    // Reuse detection revokes by family, and that UPDATE is on the incident path where
    // latency matters least - but it is also the only query that scans by family, and the
    // index costs one page in a table this shape.
    index('refresh_tokens_family_id_idx').on(t.familyId),
    index('refresh_tokens_user_id_idx').on(t.userId),

    foreignKey({
      name: 'refresh_tokens_replaced_by_fk',
      columns: [t.replacedBy],
      foreignColumns: [t.id],
    }),

    check('refresh_tokens_expires_after_issue', sql`${t.expiresAt} > ${t.issuedAt}`),
    check('refresh_tokens_replaced_by_not_self', sql`${t.replacedBy} is distinct from ${t.id}`),

    // A successor exists only where one was redeemed. The converse is not required: a
    // redeemed token whose family was revoked in the same breath never gets a successor.
    check('refresh_tokens_replacement_implies_redeemed', sql`${t.replacedBy} is null or ${t.redeemedAt} is not null`),
  ],
);

/**
 * Who may do what, in which book.
 *
 * The role is stored; the permissions are not. `domain/policy.ts` holds the single map
 * from permission to roles, and putting permissions in the database would immediately make
 * two authorities out of one - the usual way an authorisation system ends up allowing
 * something nobody meant to allow.
 */
export const bookMembers = pgTable(
  'book_members',
  {
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: bookRole('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    // One role per user per book, and the primary key is also the index the authorisation
    // middleware hits on every single request.
    primaryKey({ name: 'book_members_pkey', columns: [t.bookId, t.userId] }),

    // The other direction: the books a user belongs to. Not served by the primary key,
    // whose leading column is the book.
    index('book_members_user_id_idx').on(t.userId),
  ],
);

/**
 * API keys for machine clients.
 *
 * Scoped to one book with one role, which is narrower than a user - a user may be a member
 * of many books, a key never is. That is deliberate: a key is a credential that lives in
 * someone's CI configuration, and the blast radius of losing one should be a single book.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),
    role: bookRole('role').notNull(),

    // SHA-256 of the presented key, hex encoded. Unlike a password this is high-entropy
    // random, so a fast hash is the right one; unlike a refresh token it is not peppered,
    // because a key is verified by exact lookup and the pepper would buy only what the
    // 256-bit random part already provides.
    tokenHash: text('token_hash').notNull(),

    // What the UI can show: scheme, environment and the first characters of the random
    // part. Enough to tell two keys apart in a list, useless for authenticating.
    prefix: text('prefix').notNull(),

    name: text('name').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),

    // Advanced at most once a minute, not on every request: a read endpoint that writes a
    // row per call is a read endpoint that takes a lock per call, and minute resolution
    // answers the only question this column exists for - is this key still in use.
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),

    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    unique('api_keys_token_hash_key').on(t.tokenHash),
    index('api_keys_book_id_idx').on(t.bookId),
    check('api_keys_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check('api_keys_prefix_shape', sql`${t.prefix} ~ '^lk_[a-z]+_'`),
  ],
);

/**
 * Transport-level replay protection, complementary to `entries.external_id`.
 *
 * The two solve different halves of the same problem. `external_id` makes recording the
 * same entry twice a no-op no matter how it arrives; this makes retrying the same HTTP
 * call return the same HTTP response - including for requests that create no entry at all,
 * and including the 422 the first attempt received.
 *
 * The row is inserted before the handler runs, which is what makes reserving a key atomic:
 * a concurrent retry loses the insert and can tell from `completed_at` whether the first
 * attempt is still in flight or has an answer to hand back.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id),

    /** Caller-supplied, from the `Idempotency-Key` header. */
    key: text('key').notNull(),

    // SHA-256 over the method, the path and the raw body. Replaying a key against a
    // different request is a client bug, and returning the first request's response to it
    // would hide the bug behind a plausible answer.
    requestFingerprint: text('request_fingerprint').notNull(),

    /** Null until the first attempt finishes. Null here is what "in flight" means. */
    status: integer('status'),
    responseBody: jsonb('response_body'),

    /** The entry the call created, where it created one. Links an HTTP retry to history. */
    entryId: uuid('entry_id').references(() => entries.id),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pkey', columns: [t.bookId, t.key] }),
    check('idempotency_keys_key_not_blank', sql`length(btrim(${t.key})) > 0`),

    // Complete means all three, or none of them. A row with a status and no timestamp
    // would read as in-flight to the next request and as finished to the one after it.
    check(
      'idempotency_keys_completion_consistent',
      sql`(${t.completedAt} is null) = (${t.status} is null) and (${t.completedAt} is null) = (${t.responseBody} is null)`,
    ),
  ],
);
