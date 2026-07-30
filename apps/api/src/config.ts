import { z } from 'zod';

/**
 * The only module in the application that reads `process.env`.
 *
 * Everything else takes configuration as an argument. That is not tidiness for its own
 * sake: a module that reaches for an environment variable at import time is a module whose
 * behaviour depends on the order its file happened to be loaded in, cannot be tested with
 * two different configurations in the same process, and fails at the moment of first use
 * rather than at boot. An ESLint rule (`eslint.config.js`) makes the restriction real by
 * banning `process.env` everywhere but here and in the drizzle-kit config, which
 * drizzle-kit loads in its own process before any of this exists.
 *
 * The `.env` file itself is loaded by Node, not by this module: the package scripts pass
 * `--env-file-if-exists`. Real environment variables therefore always win over the file,
 * and importing this module has no side effects at all.
 */

const nodeEnv = z.enum(['development', 'test', 'production']);
const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

/**
 * A Postgres connection string, checked for the two things a typo actually produces: a URL
 * that does not parse, and a URL for something other than Postgres. Credentials and
 * reachability are deliberately not validated here - a config module that opens a socket is
 * a config module that cannot be unit tested, and the first query fails clearly enough.
 */
const postgresUrl = z.string().check((ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(ctx.value);
  } catch {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message: 'must be a URL, such as postgres://user:password@host:5432/database',
    });
    return;
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message: `must use the postgres:// scheme, got ${parsed.protocol}//`,
    });
  }
});

/** A whole number from an environment variable, which is always a string or absent. */
const positiveInt = z.coerce.number().int().positive();

const envSchema = z
  .object({
    NODE_ENV: nodeEnv.default('development'),
    PORT: positiveInt.max(65_535).default(3000),
    LOG_LEVEL: logLevel.default('info'),

    /** ledger_app. SELECT and INSERT on history, with UPDATE and DELETE revoked. */
    DATABASE_URL: postgresUrl,

    /** ledger_owner. Owns the schema; only the migration CLI ever opens this. */
    DATABASE_MIGRATION_URL: postgresUrl,

    DATABASE_POOL_MAX: positiveInt.max(1000).default(10),
  })
  .superRefine((env, ctx) => {
    // The whole point of two roles is that the runtime one cannot rewrite history or grant
    // itself back the right to. Pointing both variables at the same role satisfies every
    // check above and quietly deletes that guarantee, so it is worth one comparison here
    // rather than a puzzled afternoon later.
    const runtimeRole = usernameOf(env.DATABASE_URL);
    const migrationRole = usernameOf(env.DATABASE_MIGRATION_URL);

    if (runtimeRole !== undefined && runtimeRole === migrationRole) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message:
          `must not use the same role as DATABASE_MIGRATION_URL (both are "${runtimeRole}"). ` +
          'The runtime role exists to be incapable of altering the schema or history; sharing ' +
          'one role with the migrator gives that capability back.',
      });
    }
  });

function usernameOf(url: string): string | undefined {
  try {
    const { username } = new URL(url);
    return username === '' ? undefined : decodeURIComponent(username);
  } catch {
    return undefined;
  }
}

export interface DatabaseConfig {
  /** Runtime connection string. */
  readonly url: string;
  /** Migration-only connection string. */
  readonly migrationUrl: string;
  readonly poolMax: number;
}

export interface Config {
  readonly nodeEnv: z.infer<typeof nodeEnv>;
  readonly isProduction: boolean;
  readonly port: number;
  readonly logLevel: z.infer<typeof logLevel>;
  readonly database: DatabaseConfig;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Validates an environment and returns the configuration, or throws.
 *
 * Throws rather than returning a result type because there is exactly one caller and
 * exactly one sane reaction: refuse to start. A process running with configuration it could
 * not validate is a process nobody can reason about.
 *
 * The source is a parameter, defaulting to `process.env`, so tests can hand it an object.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    throw new ConfigError(`invalid environment:\n${z.prettifyError(parsed.error)}`);
  }

  const env = parsed.data;

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    database: Object.freeze({
      url: env.DATABASE_URL,
      migrationUrl: env.DATABASE_MIGRATION_URL,
      poolMax: env.DATABASE_POOL_MAX,
    }),
  });
}

let cached: Config | undefined;

/**
 * The process-wide configuration, validated once on first call.
 *
 * Memoised rather than evaluated at module load, so that importing anything transitively
 * touching this file does not blow up a test run that has no environment. The composition
 * root calls it at boot, which is where the "throws at boot" promise is kept.
 */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
