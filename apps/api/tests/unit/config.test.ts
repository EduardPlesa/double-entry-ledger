import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

/**
 * The config module is the one place `process.env` is read, so it is also the one place a
 * typo in an environment variable can be caught. These tests hand it an object rather than
 * touching the real environment - which is the property that makes them tests rather than a
 * report on this machine.
 */

function validEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://ledger_app:pw@localhost:5433/ledger',
    DATABASE_MIGRATION_URL: 'postgres://ledger_owner:pw@localhost:5433/ledger',
    AUTH_JWT_SECRET: 'a'.repeat(32),
    AUTH_REFRESH_TOKEN_PEPPER: 'b'.repeat(32),
  };
}

describe('loadConfig', () => {
  it('reads the two connection strings and applies defaults for the rest', () => {
    const config = loadConfig(validEnv());

    expect(config.database.url).toBe(validEnv().DATABASE_URL);
    expect(config.database.migrationUrl).toBe(validEnv().DATABASE_MIGRATION_URL);
    expect(config.database.poolMax).toBe(10);
    expect(config.nodeEnv).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
  });

  it('coerces the numeric variables, which arrive as strings', () => {
    const config = loadConfig({ ...validEnv(), PORT: '8080', DATABASE_POOL_MAX: '25' });

    expect(config.port).toBe(8080);
    expect(config.database.poolMax).toBe(25);
  });

  it('throws when a required variable is missing, naming it', () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = validEnv();

    expect(() => loadConfig(withoutUrl)).toThrow(ConfigError);
    expect(() => loadConfig(withoutUrl)).toThrow(/DATABASE_URL/);
  });

  it('rejects a connection string that is not a Postgres URL', () => {
    expect(() => loadConfig({ ...validEnv(), DATABASE_URL: 'not a url' })).toThrow(/must be a URL/);
    expect(() =>
      loadConfig({ ...validEnv(), DATABASE_URL: 'mysql://ledger_app:pw@localhost:3306/ledger' }),
    ).toThrow(/postgres:\/\//);
  });

  it('rejects the runtime and migration roles being the same', () => {
    // Everything about invariant 2 rests on the runtime connection being incapable of
    // rewriting history. One role for both jobs passes every other check and quietly hands
    // that capability back, so it fails here instead of in production.
    expect(() =>
      loadConfig({
        ...validEnv(),
        DATABASE_URL: 'postgres://ledger_owner:pw@localhost:5433/ledger',
        DATABASE_MIGRATION_URL: 'postgres://ledger_owner:pw@localhost:5433/ledger',
      }),
    ).toThrow(/same role/);
  });

  it('rejects values outside their range, and non-numeric ports', () => {
    expect(() => loadConfig({ ...validEnv(), PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), PORT: 'http' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), DATABASE_POOL_MAX: '0' })).toThrow(ConfigError);
  });

  it('rejects an unknown NODE_ENV rather than guessing', () => {
    expect(() => loadConfig({ ...validEnv(), NODE_ENV: 'staging' })).toThrow(ConfigError);
    expect(loadConfig({ ...validEnv(), NODE_ENV: 'production' }).isProduction).toBe(true);
  });

  it('reports every problem at once, not the first', () => {
    let message = '';
    try {
      loadConfig({ DATABASE_URL: 'nope', PORT: 'also nope' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/DATABASE_MIGRATION_URL/);
    expect(message).toMatch(/PORT/);
  });

  it('returns a frozen object, so nothing can reconfigure the process at runtime', () => {
    const config = loadConfig(validEnv());

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.auth)).toBe(true);
    expect(Object.isFrozen(config.auth.argon2)).toBe(true);
  });
});

describe('loadConfig, authentication', () => {
  it('applies the defaults that have one', () => {
    const { auth } = loadConfig(validEnv());

    expect(auth.jwtIssuer).toBe('ledger');
    expect(auth.jwtAudience).toBe('ledger-api');
    expect(auth.accessTokenTtlSeconds).toBe(600);
    expect(auth.refreshTokenTtlSeconds).toBe(2_592_000);
    expect(auth.argon2).toEqual({ memoryCostKib: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('requires both secrets, with no default for either', () => {
    const { AUTH_JWT_SECRET: _jwt, ...withoutJwt } = validEnv();
    const { AUTH_REFRESH_TOKEN_PEPPER: _pepper, ...withoutPepper } = validEnv();

    expect(() => loadConfig(withoutJwt)).toThrow(/AUTH_JWT_SECRET/);
    expect(() => loadConfig(withoutPepper)).toThrow(/AUTH_REFRESH_TOKEN_PEPPER/);
  });

  it('rejects a secret short enough to have been typed by hand', () => {
    // Not a strength check - `'a'.repeat(32)` passes and is worthless. It rules out the
    // category of secret someone invents at the keyboard, and makes the placeholder in
    // .env.example fail rather than run.
    expect(() => loadConfig({ ...validEnv(), AUTH_JWT_SECRET: 'short' })).toThrow(/at least 32/);
  });

  it('rejects one value used as both secrets', () => {
    // Both work perfectly well when they are the same, which is exactly why nothing else
    // would ever notice. One leak should not compromise signing and storage at once.
    expect(() =>
      loadConfig({ ...validEnv(), AUTH_REFRESH_TOKEN_PEPPER: validEnv().AUTH_JWT_SECRET }),
    ).toThrow(/must differ from AUTH_JWT_SECRET/);
  });

  it('refuses an access-token lifetime long enough to stop being short-lived', () => {
    // "Just make it a day while I debug this" is a one-character change to an env file. It
    // should have to be argued for rather than typed.
    expect(() => loadConfig({ ...validEnv(), AUTH_ACCESS_TOKEN_TTL_SECONDS: '86400' })).toThrow(
      ConfigError,
    );
    expect(loadConfig({ ...validEnv(), AUTH_ACCESS_TOKEN_TTL_SECONDS: '120' }).auth.accessTokenTtlSeconds).toBe(120);
  });

  it('derives the API key environment label from NODE_ENV', () => {
    expect(loadConfig(validEnv()).apiKeyEnvironment).toBe('dev');
    expect(loadConfig({ ...validEnv(), NODE_ENV: 'test' }).apiKeyEnvironment).toBe('test');
    expect(loadConfig({ ...validEnv(), NODE_ENV: 'production' }).apiKeyEnvironment).toBe('live');
  });
});

describe('LEDGER_CONCURRENCY_STRATEGY', () => {
  it('defaults to row locks', () => {
    expect(loadConfig(validEnv()).concurrency.strategy).toBe('row-lock');
  });

  it('accepts serializable', () => {
    expect(
      loadConfig({ ...validEnv(), LEDGER_CONCURRENCY_STRATEGY: 'serializable' }).concurrency
        .strategy,
    ).toBe('serializable');
  });

  it('rejects anything else', () => {
    expect(() => loadConfig({ ...validEnv(), LEDGER_CONCURRENCY_STRATEGY: 'yolo' })).toThrow(
      ConfigError,
    );
  });
});
