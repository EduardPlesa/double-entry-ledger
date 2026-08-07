/**
 * A corpus big enough for the plans to mean something.
 *
 * 250,000 entries of two legs each. Bulk `INSERT ... SELECT FROM generate_series` rather than
 * 250,000 round trips through the service, and as ledger_owner rather than ledger_app: the
 * owner is exempt from row-level security, which is what lets one statement write a book's
 * worth of rows.
 *
 * The constraint triggers are disabled for the load and re-enabled after it. They are not
 * being bypassed - what they check is checked here too, once, in bulk, by the verification
 * queries at the end. Firing a deferred per-entry trigger 250,000 times and a per-posting
 * overdraft scan 250,000 times would cost many minutes to establish what two aggregate
 * queries establish in seconds. The difference matters only because this script is expected
 * to be re-run whenever the numbers are re-taken.
 *
 * Every parameter below is a constant and the RNG is seeded, so the corpus is the same
 * corpus on any machine. docs/performance.md quotes these values; if you change one, change
 * them there too or the plans stop being reproducible.
 */
import { Pool } from 'pg';
import { getConfig } from '../src/config.js';

const POSTINGS = 500_000; // two per entry
const ASSET_ACCOUNTS = 100;
const REVENUE_ACCOUNTS = 100;
const START = '2023-01-01T00:00:00Z';
const SPAN_DAYS = 1095; // three years
const BACKDATED_EVERY = 10; // one entry in ten occurs before its predecessor
const BACKDATE_MAX_DAYS = 180;
const RNG_SEED = 0.42;
const CURRENCY = 'EUR';

interface Args {
  /** Total postings, always even - two legs per entry. */
  readonly postings: number;
}

/** `--postings N`, so CI can run this same script small. Defaults to the full corpus. */
function parseArgs(argv: readonly string[]): Args {
  const flagIndex = argv.indexOf('--postings');
  if (flagIndex === -1) return { postings: POSTINGS };

  const raw = argv[flagIndex + 1];
  const postings = raw === undefined ? NaN : Number(raw);

  if (!Number.isInteger(postings) || postings <= 0 || postings % 2 !== 0) {
    throw new Error(`--postings must be a positive even integer, got ${raw ?? '(missing)'}`);
  }

  return { postings };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entryCount = args.postings / 2;

  // ledger_owner, not ledger_app: disabling a constraint trigger requires table ownership,
  // and the owner is who row-level security does not apply to. max: 1 so setseed() and the
  // insert that consumes it always share one backend session - a pool handing the insert to
  // a different connection would make the "seeded" RNG unseeded again.
  const pool = new Pool({ connectionString: getConfig().database.migrationUrl, max: 1 });

  const timings: [label: string, ms: number][] = [];
  const timed = async (label: string, work: () => Promise<void>): Promise<void> => {
    const startedAt = Date.now();
    await work();
    timings.push([label, Date.now() - startedAt]);
  };

  try {
    let bookId = '';

    await timed('accounts', async () => {
      bookId = await seedBookAndAccounts(pool);
    });

    try {
      await disableTriggers(pool);
      await timed('entries', () => seedEntries(pool, bookId, entryCount));
      await timed('postings', () => seedPostings(pool, bookId));
    } finally {
      // Re-enabled unconditionally, however far the block above got - including if
      // disableTriggers itself threw partway through its three statements. ENABLE TRIGGER
      // on a trigger that was never disabled, or that is already enabled, is a no-op, so
      // this is safe to run no matter which of the three DISABLEs actually landed. A failed
      // load - or a failed disable - must not leave the database with its invariants
      // switched off for whoever runs the next migration or the next seed - see the module
      // comment.
      await enableTriggers(pool);
    }

    const results = await verify(pool);
    for (const result of results) {
      process.stdout.write(`${result.label} ${result.count.toString()}\n`);
    }

    await timed('analyze', () => analyze(pool));

    const counts = await countRows(pool, bookId);

    process.stdout.write(`book ${bookId}\n`);
    process.stdout.write(`entries ${counts.entries.toString()}\n`);
    process.stdout.write(`postings ${counts.postings.toString()}\n`);
    for (const [label, ms] of timings) {
      process.stdout.write(`${label} ${ms.toString()}ms\n`);
    }

    // A seed that produced invalid data must fail loudly, because everything downstream -
    // Task 2's plans, Task 4's docs - measures a corpus this script is claiming is sound.
    if (results.some((result) => result.count > 0)) {
      process.stderr.write('verification failed: see non-zero counts above\n');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

/** One book, `ASSET_ACCOUNTS` asset accounts and `REVENUE_ACCOUNTS` revenue accounts. */
async function seedBookAndAccounts(pool: Pool): Promise<string> {
  const book = await pool.query<{ id: string }>(
    `INSERT INTO books (id, name, base_currency) VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
    ['performance corpus', CURRENCY],
  );
  const bookId = book.rows[0]?.id;
  if (bookId === undefined) throw new Error('book insert returned no id');

  await pool.query(
    `INSERT INTO accounts (id, book_id, name, type, currency)
     SELECT gen_random_uuid(), $1, 'asset ' || i, 'asset', $2
     FROM generate_series(1, $3) AS i`,
    [bookId, CURRENCY, ASSET_ACCOUNTS],
  );

  await pool.query(
    `INSERT INTO accounts (id, book_id, name, type, currency)
     SELECT gen_random_uuid(), $1, 'revenue ' || i, 'revenue', $2
     FROM generate_series(1, $3) AS i`,
    [bookId, CURRENCY, REVENUE_ACCOUNTS],
  );

  return bookId;
}

/** See `drizzle/0003_invariants.sql` and `0007_overdraft.sql` for what each trigger checks. */
async function disableTriggers(pool: Pool): Promise<void> {
  await pool.query('ALTER TABLE postings DISABLE TRIGGER postings_entry_balanced');
  await pool.query('ALTER TABLE postings DISABLE TRIGGER postings_account_not_overdrawn');
  await pool.query('ALTER TABLE entries DISABLE TRIGGER entries_have_postings');
}

/** Same statement order as `disableTriggers`, so the pair reads as one operation undone. */
async function enableTriggers(pool: Pool): Promise<void> {
  await pool.query('ALTER TABLE postings ENABLE TRIGGER postings_entry_balanced');
  await pool.query('ALTER TABLE postings ENABLE TRIGGER postings_account_not_overdrawn');
  await pool.query('ALTER TABLE entries ENABLE TRIGGER entries_have_postings');
}

/**
 * `entryCount` entries, mostly forward through `SPAN_DAYS`, with one in `BACKDATED_EVERY`
 * landing up to `BACKDATE_MAX_DAYS` earlier. That skew is the point of the corpus: a ledger
 * whose `occurred_at` order matched its id order would never exercise the distinction the
 * checkpoint design rests on.
 */
async function seedEntries(pool: Pool, bookId: string, entryCount: number): Promise<void> {
  // Before any random() in this session - and this session only, because the pool above is
  // capped at one connection - so the corpus is the same corpus on every run.
  await pool.query('SELECT setseed($1)', [RNG_SEED]);

  await pool.query(
    `INSERT INTO entries (id, book_id, occurred_at, recorded_at, description, external_id)
     SELECT
       gen_random_uuid(),
       $1,
       $2::timestamptz
         + (i * ($3::numeric / $4)) * interval '1 day'
         - CASE WHEN i % $5 = 0 THEN (random() * $6) * interval '1 day' ELSE interval '0' END,
       now(),
       'seed ' || i,
       NULL
     FROM generate_series(1, $4) AS i`,
    [bookId, START, SPAN_DAYS, entryCount, BACKDATED_EVERY, BACKDATE_MAX_DAYS],
  );
}

/**
 * Two legs per entry: the positive one to an asset account, the negative one to a revenue
 * account. Asset accounts therefore only ever receive credit, so no guarded account can go
 * negative - which is what makes `verify`'s third query pass rather than a discovery. The
 * account is chosen by the entry's row number rather than by `random()`, so the distribution
 * is fixed across runs.
 */
async function seedPostings(pool: Pool, bookId: string): Promise<void> {
  await pool.query(
    `WITH numbered AS (
       SELECT
         e.id,
         e.book_id,
         row_number() OVER (ORDER BY e.occurred_at, e.id) AS n,
         -- 100 to 200 000 minor units, from the row number rather than a fresh random(), so
         -- the amounts are the same corpus on every run without depending on evaluation order.
         (100 + (row_number() OVER (ORDER BY e.occurred_at, e.id) * 7919) % 199901)::bigint AS amount
       FROM entries e
       WHERE e.book_id = $1
     ),
     assets AS (
       SELECT id, row_number() OVER (ORDER BY id) - 1 AS k
       FROM accounts WHERE book_id = $1 AND type = 'asset'
     ),
     revenues AS (
       SELECT id, row_number() OVER (ORDER BY id) - 1 AS k
       FROM accounts WHERE book_id = $1 AND type = 'revenue'
     )
     INSERT INTO postings (entry_id, book_id, account_id, amount_minor, currency)
     SELECT n.id, n.book_id, a.id, n.amount, $2
     FROM numbered n JOIN assets a ON a.k = n.n % $3
     UNION ALL
     SELECT n.id, n.book_id, r.id, -n.amount, $2
     FROM numbered n JOIN revenues r ON r.k = (n.n / $3) % $4`,
    [bookId, CURRENCY, ASSET_ACCOUNTS, REVENUE_ACCOUNTS],
  );
}

interface VerificationResult {
  readonly label: string;
  readonly count: number;
}

/**
 * The three queries that replace the disabled triggers. Each checks exactly what its trigger
 * would have checked - see `drizzle/0003_invariants.sql` and `0007_overdraft.sql` - once, in
 * bulk, instead of once per row.
 *
 * Database-wide, not scoped to the book just written - the same scope the triggers
 * themselves had. That is a real property of running this against a non-empty database:
 * unrelated data left over from an earlier run, or from anything else with a foot in
 * `entries`/`postings`, is included in the count and can fail a load that was itself fine.
 * A dedicated performance database, wiped between runs, is what makes the result mean only
 * what it claims to.
 */
async function verify(pool: Pool): Promise<VerificationResult[]> {
  // What postings_entry_balanced would have checked: every entry sums to zero, per currency.
  const unbalanced = await pool.query<{ unbalanced: string }>(
    `SELECT count(*) AS unbalanced FROM (
       SELECT entry_id FROM postings GROUP BY entry_id, currency HAVING sum(amount_minor) <> 0
     ) bad`,
  );

  // What entries_have_postings would have checked: every entry has at least one leg.
  const legless = await pool.query<{ legless: string }>(
    `SELECT count(*) AS legless FROM entries e
     WHERE NOT EXISTS (SELECT 1 FROM postings p WHERE p.entry_id = e.id)`,
  );

  // What postings_account_not_overdrawn would have checked: no guarded account is ever
  // negative at any prefix of its history. `guarded_account_types()` (drizzle/0007_overdraft.sql)
  // is the single source for which types those are - asset today - precisely so this
  // duplicates the trigger's own filter instead of hard-coding 'asset' a second place that
  // would go silently stale the day the guarded set grows.
  //
  // Postgres will not let an aggregate call (min) wrap a window function call
  // (sum() OVER (...)) directly - 42803, "aggregate function calls cannot contain window
  // function calls" - so this is two subqueries, not one: the innermost produces one
  // running-sum row per posting, the middle aggregates that down to one lowest-point row
  // per account, and the outer counts the accounts where that point went negative. The same
  // three-level shape as the "establish the invariant" block in drizzle/0007_overdraft.sql,
  // which the equivalent per-posting trigger query has to use for the same reason.
  const overdrawn = await pool.query<{ overdrawn: string }>(
    `SELECT count(*) AS overdrawn FROM (
       SELECT prefixes.account_id, min(prefixes.running) AS lowest
       FROM (
         SELECT
           p.account_id,
           sum(p.amount_minor) OVER (
             PARTITION BY p.account_id ORDER BY e.occurred_at, p.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS running
         FROM postings p
         JOIN entries e ON e.id = p.entry_id
         JOIN accounts a ON a.id = p.account_id
         WHERE a.type = ANY (public.guarded_account_types())
       ) prefixes
       GROUP BY prefixes.account_id
     ) lowest_per_account WHERE lowest_per_account.lowest < 0`,
  );

  return [
    { label: 'unbalanced', count: Number(unbalanced.rows[0]?.unbalanced ?? '0') },
    { label: 'legless', count: Number(legless.rows[0]?.legless ?? '0') },
    { label: 'overdrawn', count: Number(overdrawn.rows[0]?.overdrawn ?? '0') },
  ];
}

/** A fresh bulk load has no statistics, and a plan taken against stale ones describes a database nobody has. */
async function analyze(pool: Pool): Promise<void> {
  await pool.query('ANALYZE entries');
  await pool.query('ANALYZE postings');
}

async function countRows(
  pool: Pool,
  bookId: string,
): Promise<{ entries: number; postings: number }> {
  const result = await pool.query<{ entries: string; postings: string }>(
    `SELECT
       (SELECT count(*) FROM entries WHERE book_id = $1) AS entries,
       (SELECT count(*) FROM postings WHERE book_id = $1) AS postings`,
    [bookId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('count query returned no row');

  return { entries: Number(row.entries), postings: Number(row.postings) };
}

await main();
