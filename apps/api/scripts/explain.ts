/**
 * The plans, as the application gets them.
 *
 * Connected as ledger_app inside a transaction with `app.current_book_id` set, because the
 * row-level security predicate is part of every one of these queries in production and a
 * plan captured as the owner would omit it. That is the difference between measuring the
 * system and measuring a query that resembles it.
 *
 * `--mode baseline` drops the stage-7 indexes before capturing; `--mode indexed` creates
 * them. Both run as the owner, since ledger_app cannot alter the schema - which is the point
 * of that split and not an inconvenience.
 *
 * Every SQL string below is what `src/repositories/ledger.repository.ts` actually hands to
 * Postgres, confirmed with `.toSQL()` rather than typed from the method name - `sumPostings`
 * joins `entries` even with no `asOf`, for one example a paraphrase would miss. Capturing an
 * approximation would measure a query nobody runs.
 */
import { Pool, type PoolClient } from 'pg';
import { getConfig } from '../src/config.js';

interface Args {
  readonly bookId: string;
  readonly mode: 'baseline' | 'indexed';
}

/** `--book <id> --mode baseline|indexed`. Both required - neither has a sane default. */
function parseArgs(argv: readonly string[]): Args {
  const bookFlag = argv.indexOf('--book');
  const modeFlag = argv.indexOf('--mode');

  const bookId = bookFlag === -1 ? undefined : argv[bookFlag + 1];
  const mode = modeFlag === -1 ? undefined : argv[modeFlag + 1];

  if (bookId === undefined) {
    throw new Error('usage: perf:explain --book <bookId> --mode baseline|indexed');
  }
  if (mode !== 'baseline' && mode !== 'indexed') {
    throw new Error(`--mode must be "baseline" or "indexed", got ${mode ?? '(missing)'}`);
  }

  return { bookId, mode };
}

/**
 * Drops or creates the stage-7 indexes, as the owner - ledger_app cannot alter the schema,
 * which is the point of the role split and not an inconvenience here. The names match what
 * Task 3's migration creates exactly, because this is the harness that measured them.
 *
 * `ANALYZE` runs after either change so the planner is choosing with this mode's statistics
 * rather than the other mode's - see `scripts/seed-perf.ts`'s own `analyze` for the same rule
 * applied to a fresh load.
 */
async function setIndexState(ownerPool: Pool, mode: Args['mode']): Promise<void> {
  if (mode === 'baseline') {
    await ownerPool.query('DROP INDEX IF EXISTS postings_account_id_id_idx');
    await ownerPool.query('DROP INDEX IF EXISTS postings_entry_id_idx');
  } else {
    await ownerPool.query(
      'CREATE INDEX IF NOT EXISTS postings_account_id_id_idx ON postings (account_id, id)',
    );
    await ownerPool.query('CREATE INDEX IF NOT EXISTS postings_entry_id_idx ON postings (entry_id)');
  }

  await ownerPool.query('ANALYZE postings');
}

interface HotAccount {
  readonly accountId: string;
  readonly postingCount: string;
}

/**
 * The asset account with the most postings, so the numbers describe the hot case rather than
 * a lucky one. Asset, not any account: it is the type `lowest-prefix`'s overdraft scan
 * actually guards (`guarded_account_types()`, `drizzle/0007_overdraft.sql`), and picking an
 * account that scan never runs for would describe a case the system does not have.
 *
 * This deliberately narrows the plan's own `SELECT account_id FROM postings GROUP BY
 * account_id ORDER BY count(*) DESC LIMIT 1` by joining `accounts` and filtering on type.
 * The seed corpus (`scripts/seed-perf.ts`) splits postings evenly across the 100 asset and
 * 100 revenue accounts - every account ties at the same count - so the unfiltered query
 * would land on whichever Postgres happens to visit first among *all* 200, asset or revenue,
 * and only accidentally on the account the description above actually means.
 */
async function pickHotAccount(client: PoolClient): Promise<HotAccount> {
  const result = await client.query<{ account_id: string; n: string }>(`
    select p.account_id, count(*) as n
    from postings p
    join accounts a on a.id = p.account_id
    where a.type = 'asset'
    group by p.account_id
    order by count(*) desc
    limit 1
  `);

  const row = result.rows[0];
  if (row === undefined) throw new Error('no postings found on any asset account in this book');
  return { accountId: row.account_id, postingCount: row.n };
}

/**
 * The account's current checkpoint watermark, needed to bind `balance-from-checkpoint`'s
 * delta statement. Query 2 needs a checkpoint to exist - the report notes that
 * `pnpm --filter @ledger/api checkpoint <bookId>` must run first, and this fails loudly
 * rather than silently falling back to `balance-from-zero`'s plan under a different name.
 */
async function fetchCheckpointThroughId(client: PoolClient, accountId: string): Promise<string> {
  const result = await client.query<{ through_id: string }>(
    'select "account_id", "through_id", "balance_minor", "computed_at" from "balance_checkpoints" where "balance_checkpoints"."account_id" = $1 order by "balance_checkpoints"."through_id" desc limit $2',
    [accountId, 1],
  );

  const throughId = result.rows[0]?.through_id;
  if (throughId === undefined) {
    throw new Error(
      `account ${accountId} has no checkpoint. Run "pnpm --filter @ledger/api checkpoint <bookId>" first.`,
    );
  }
  return throughId;
}

/**
 * A posting id partway through the account's history, for `postings-page`'s cursor. Derived
 * from the account's own row count rather than a hardcoded offset, so the same script keeps
 * working if it is ever pointed at a smaller corpus (`perf:seed --postings N`).
 */
async function pickPageCursor(client: PoolClient, accountId: string): Promise<string> {
  const countResult = await client.query<{ n: string }>(
    'select count(*) as n from postings where account_id = $1',
    [accountId],
  );
  const total = BigInt(countResult.rows[0]?.n ?? '0');

  const cursorResult = await client.query<{ id: string }>(
    'select id from postings where account_id = $1 order by id offset $2 limit 1',
    [accountId, (total / 2n).toString()],
  );

  const id = cursorResult.rows[0]?.id;
  if (id === undefined) throw new Error(`account ${accountId} has no postings to page through`);
  return id;
}

interface Statement {
  /** Sub-label for a section with more than one statement. Undefined when there is only one. */
  readonly label: string | undefined;
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface Section {
  readonly heading: string;
  readonly description: string;
  readonly statements: readonly Statement[];
}

/**
 * The five queries (six statements), built from the account and watermark this run picked.
 * SQL text is copied verbatim from what Drizzle emits for each repository method - see the
 * module comment - except `lowest-prefix`, which the repository already writes as raw SQL.
 */
function buildSections(accountId: string, bookId: string, throughId: string, cursorId: string): Section[] {
  return [
    {
      heading: 'balance-from-zero',
      description:
        'The naive account sum - `sumPostings` with no `asOf`. Still the only answer for an ' +
        'account with no checkpoint.',
      statements: [
        {
          label: undefined,
          sql: 'select coalesce(sum("postings"."amount_minor"), 0)::text from "postings" inner join "entries" on "entries"."id" = "postings"."entry_id" where "postings"."account_id" = $1',
          params: [accountId],
        },
      ],
    },
    {
      heading: 'balance-from-checkpoint',
      description:
        'Two statements under one heading, because the read `getBalance` performs is two: ' +
        '`latestCheckpoint`, then `sumPostingsAfter` for everything after its watermark.',
      statements: [
        {
          label: 'Checkpoint lookup',
          sql: 'select "account_id", "through_id", "balance_minor", "computed_at" from "balance_checkpoints" where "balance_checkpoints"."account_id" = $1 order by "balance_checkpoints"."through_id" desc limit $2',
          params: [accountId, 1],
        },
        {
          label: 'Delta sum',
          sql: 'select coalesce(sum("amount_minor"), 0)::text from "postings" where ("postings"."account_id" = $1 and "postings"."id" > $2)',
          params: [accountId, throughId],
        },
      ],
    },
    {
      heading: 'lowest-prefix',
      description:
        "The overdraft scan, from `lowestPrefixBalance` verbatim - it runs under the account's " +
        'row lock on every write that touches it.',
      statements: [
        {
          label: undefined,
          sql: `select running::text as balance, occurred_at
from (
  select
    sum("postings"."amount_minor") over (
      order by "entries"."occurred_at", "postings"."id"
      rows between unbounded preceding and current row
    ) as running,
    "entries"."occurred_at" as occurred_at
  from "postings"
  join "entries" on "entries"."id" = "postings"."entry_id"
  where "postings"."account_id" = $1
) prefixes
order by running asc, occurred_at asc
limit 1`,
          params: [accountId],
        },
      ],
    },
    {
      heading: 'trial-balance',
      description:
        'The whole-book aggregate from `trialBalance`: every account in the book, LEFT JOINed ' +
        'to its postings so an account with none still appears at zero.',
      statements: [
        {
          label: undefined,
          sql: 'select "accounts"."id", "accounts"."name", "accounts"."type", "accounts"."currency", coalesce(sum("postings"."amount_minor"), 0)::text from "accounts" left join "postings" on "postings"."account_id" = "accounts"."id" left join "entries" on "entries"."id" = "postings"."entry_id" where "accounts"."book_id" = $1 group by "accounts"."id", "accounts"."name", "accounts"."type", "accounts"."currency" order by "accounts"."type" asc, "accounts"."name" asc',
          params: [bookId],
        },
      ],
    },
    {
      heading: 'postings-page',
      description:
        "One page from `listPostings`: the account's postings after a keyset cursor, oldest " +
        'first, one row over the page size so the caller can tell whether a next page exists.',
      statements: [
        {
          label: undefined,
          sql: 'select "postings"."id", "postings"."entry_id", "postings"."amount_minor", "postings"."currency", "entries"."occurred_at", "entries"."recorded_at", "entries"."description" from "postings" inner join "entries" on "entries"."id" = "postings"."entry_id" where ("postings"."account_id" = $1 and "postings"."id" > $2) order by "postings"."id" asc limit $3',
          params: [accountId, cursorId, 51],
        },
      ],
    },
  ];
}

/**
 * Runs one statement's `EXPLAIN (ANALYZE, BUFFERS)` three times and keeps only the third
 * plan. The first run measures the page cache as much as the query; by the third, the pages
 * this statement touches are as warm as they get in this session - see the module comment.
 */
async function warmPlan(client: PoolClient, statement: Statement): Promise<string> {
  let plan = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE false, FORMAT TEXT) ${statement.sql}`,
      [...statement.params],
    );
    plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
  }
  return plan;
}

/** The `Execution Time: N.NNN ms` line Postgres appends last - the number a reader wants first. */
function executionTime(plan: string): string {
  const lines = plan.trimEnd().split('\n');
  return lines[lines.length - 1]?.trim() ?? '(no plan captured)';
}

async function renderSection(client: PoolClient, section: Section): Promise<string> {
  const parts: string[] = [`### ${section.heading}\n\n${section.description}\n`];

  for (const statement of section.statements) {
    // Sequential, not Promise.all: one PoolClient is one connection, and a statement's three
    // runs must land on it in order for "third run, same session" to mean anything.
    const plan = await warmPlan(client, statement);

    if (statement.label !== undefined) parts.push(`**${statement.label}**\n`);
    parts.push(`\`\`\`sql\n${statement.sql}\n\`\`\`\n`);
    parts.push(`\`\`\`text\n${plan}\n\`\`\`\n`);
    parts.push(`Execution time (warm - third of three runs): ${executionTime(plan)}\n`);
  }

  return parts.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig();

  // max: 1 on both - this is a one-shot capture script, not a server, and there is nothing to
  // pool. seed-perf.ts caps its own pool the same way and for the same reason: one statement,
  // one session, no ambiguity about which connection did what.
  const ownerPool = new Pool({ connectionString: config.database.migrationUrl, max: 1 });
  const appPool = new Pool({ connectionString: config.database.url, max: 1 });

  try {
    await setIndexState(ownerPool, args.mode);

    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      // The same mechanism db/client.ts's transactionInBook uses: SET LOCAL takes no bind
      // parameter, so this is set_config with is_local => true, not string interpolation into
      // SQL text. Transaction-local, so it cannot leak onto whatever borrows this connection
      // next - moot here with a pool of one, but it is the real mechanism being measured.
      await client.query("select set_config('app.current_book_id', $1, true)", [args.bookId]);

      const { accountId, postingCount } = await pickHotAccount(client);
      const throughId = await fetchCheckpointThroughId(client, accountId);
      const cursorId = await pickPageCursor(client, accountId);

      const sections = buildSections(accountId, args.bookId, throughId, cursorId);

      const header =
        `# Query plans - ${args.mode}\n\n` +
        `Book \`${args.bookId}\`, account \`${accountId}\` - the busiest asset account in it, ` +
        `${postingCount} postings.\n\n` +
        'Captured as `ledger_app` inside a transaction with `app.current_book_id` set, so the ' +
        'row-level security policy (migration 0006) is part of every plan below, the way it is ' +
        'in production. Each plan is the third run of that statement on this connection in this ' +
        'session - warm; a cold first run measures the page cache, not the query.\n';

      // Sequential, not Promise.all: one PoolClient is one connection, and every section's
      // statements share it.
      const body: string[] = [];
      for (const section of sections) {
        body.push(await renderSection(client, section));
      }

      process.stdout.write(`${header}\n${body.join('\n')}\n`);

      // Read-only throughout - EXPLAIN ANALYZE executes the statement but nothing here wrote a
      // row - so there is nothing to keep. Explicit ROLLBACK says so rather than leaving it to
      // whichever of COMMIT or connection-close would have been a no-op anyway.
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await ownerPool.end();
    await appPool.end();
  }
}

await main();
