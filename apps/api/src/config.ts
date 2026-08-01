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

/**
 * A secret, with a floor on how much entropy it can possibly carry.
 *
 * 32 characters is not a measure of strength - `'a'.repeat(32)` passes - and no schema can
 * check that a value came from a CSPRNG. What it does rule out is the category of secret
 * that gets typed in by hand under time pressure, and it makes the copied-from-the-example
 * value fail rather than run.
 *
 * No defaults. A secret with a fallback is a secret that ships as the fallback, and the
 * whole point of the config module is that the process refuses to start rather than starting
 * wrong.
 */
const secret = z
  .string()
  .min(32, 'must be at least 32 characters; generate one with `openssl rand -base64 32`');

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

    /**
     * How the overdraft rule is made safe under concurrency. Row locks by default; see
     * docs/adr/0004-concurrency-control.md for why, and for what the other one costs.
     */
    LEDGER_CONCURRENCY_STRATEGY: z.enum(['row-lock', 'serializable']).default('row-lock'),

    /** Signs and verifies access tokens. Symmetric: one service does both. */
    AUTH_JWT_SECRET: secret,
    AUTH_JWT_ISSUER: z.string().min(1).default('ledger'),
    AUTH_JWT_AUDIENCE: z.string().min(1).default('ledger-api'),

    // Ten minutes. Short enough that a leaked access token is a small window, long enough
    // that the refresh endpoint is not on the critical path of every other request. The
    // upper bound is here because "just make it a day" is the change someone reaches for
    // while debugging, and it should have to be argued for rather than typed.
    AUTH_ACCESS_TOKEN_TTL_SECONDS: positiveInt.max(3600).default(600),

    /**
     * Keys the HMAC that refresh tokens are stored under. Not the JWT secret: these protect
     * different things, and one leaked value should not compromise both. Rotating this
     * invalidates every refresh token at once, which is a feature on the day it is needed.
     */
    AUTH_REFRESH_TOKEN_PEPPER: secret,
    AUTH_REFRESH_TOKEN_TTL_SECONDS: positiveInt.default(60 * 60 * 24 * 30),

    // OWASP's current argon2id minimum: 19 MiB, two passes, one lane. Configurable because
    // the right answer depends on the hardware, and because tests cannot afford to pay it -
    // a test suite that hashes at production cost either runs for minutes or quietly stops
    // testing the hashing.
    AUTH_ARGON2_MEMORY_COST_KIB: positiveInt.min(8).max(1_048_576).default(19_456),
    AUTH_ARGON2_TIME_COST: positiveInt.max(100).default(2),
    AUTH_ARGON2_PARALLELISM: positiveInt.max(16).default(1),
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

    // Same argument, one layer up. The two secrets protect different things - one signs
    // tokens the client holds, the other keys the hash of tokens the database holds - and
    // reusing one value means a single leak compromises both at once. Nothing else would
    // ever notice, because both work perfectly well.
    if (env.AUTH_JWT_SECRET === env.AUTH_REFRESH_TOKEN_PEPPER) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_REFRESH_TOKEN_PEPPER'],
        message: 'must differ from AUTH_JWT_SECRET; one leaked value should not compromise both',
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

export interface ConcurrencyConfig {
  readonly strategy: 'row-lock' | 'serializable';
}

export interface Argon2Config {
  readonly memoryCostKib: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export interface AuthConfig {
  readonly jwtSecret: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenPepper: string;
  readonly refreshTokenTtlSeconds: number;
  readonly argon2: Argon2Config;
}

/**
 * The environment label in an API key, as in `lk_dev_...`.
 *
 * Derived from NODE_ENV rather than configured separately. A key that says `live` while the
 * process it was minted by is in development is a key someone will trust in the wrong place,
 * and two variables that must agree are two variables that will eventually disagree.
 */
export type ApiKeyEnvironment = 'dev' | 'test' | 'live';

const API_KEY_ENVIRONMENTS: Readonly<Record<z.infer<typeof nodeEnv>, ApiKeyEnvironment>> = {
  development: 'dev',
  test: 'test',
  production: 'live',
};

export interface Config {
  readonly nodeEnv: z.infer<typeof nodeEnv>;
  readonly isProduction: boolean;
  readonly port: number;
  readonly logLevel: z.infer<typeof logLevel>;
  readonly database: DatabaseConfig;
  readonly concurrency: ConcurrencyConfig;
  readonly auth: AuthConfig;
  readonly apiKeyEnvironment: ApiKeyEnvironment;
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
    concurrency: Object.freeze({ strategy: env.LEDGER_CONCURRENCY_STRATEGY }),
    auth: Object.freeze({
      jwtSecret: env.AUTH_JWT_SECRET,
      jwtIssuer: env.AUTH_JWT_ISSUER,
      jwtAudience: env.AUTH_JWT_AUDIENCE,
      accessTokenTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenPepper: env.AUTH_REFRESH_TOKEN_PEPPER,
      refreshTokenTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      argon2: Object.freeze({
        memoryCostKib: env.AUTH_ARGON2_MEMORY_COST_KIB,
        timeCost: env.AUTH_ARGON2_TIME_COST,
        parallelism: env.AUTH_ARGON2_PARALLELISM,
      }),
    }),
    apiKeyEnvironment: API_KEY_ENVIRONMENTS[env.NODE_ENV],
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
