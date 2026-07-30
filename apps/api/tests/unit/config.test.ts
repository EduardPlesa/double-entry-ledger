import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

/**
 * The config module is the one place `process.env` is read, so it is also the one place a
 * typo in an environment variable can be caught. These tests hand it an object rather than
 * touching the real environment - which is the property that makes them tests rather than a
 * report on this machine.
 */

const valid = {
  DATABASE_URL: 'postgres://ledger_app:pw@localhost:5433/ledger',
  DATABASE_MIGRATION_URL: 'postgres://ledger_owner:pw@localhost:5433/ledger',
};

describe('loadConfig', () => {
  it('reads the two connection strings and applies defaults for the rest', () => {
    const config = loadConfig(valid);

    expect(config.database.url).toBe(valid.DATABASE_URL);
    expect(config.database.migrationUrl).toBe(valid.DATABASE_MIGRATION_URL);
    expect(config.database.poolMax).toBe(10);
    expect(config.nodeEnv).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
  });

  it('coerces the numeric variables, which arrive as strings', () => {
    const config = loadConfig({ ...valid, PORT: '8080', DATABASE_POOL_MAX: '25' });

    expect(config.port).toBe(8080);
    expect(config.database.poolMax).toBe(25);
  });

  it('throws when a required variable is missing, naming it', () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = valid;

    expect(() => loadConfig(withoutUrl)).toThrow(ConfigError);
    expect(() => loadConfig(withoutUrl)).toThrow(/DATABASE_URL/);
  });

  it('rejects a connection string that is not a Postgres URL', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'not a url' })).toThrow(/must be a URL/);
    expect(() =>
      loadConfig({ ...valid, DATABASE_URL: 'mysql://ledger_app:pw@localhost:3306/ledger' }),
    ).toThrow(/postgres:\/\//);
  });

  it('rejects the runtime and migration roles being the same', () => {
    // Everything about invariant 2 rests on the runtime connection being incapable of
    // rewriting history. One role for both jobs passes every other check and quietly hands
    // that capability back, so it fails here instead of in production.
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://ledger_owner:pw@localhost:5433/ledger',
        DATABASE_MIGRATION_URL: 'postgres://ledger_owner:pw@localhost:5433/ledger',
      }),
    ).toThrow(/same role/);
  });

  it('rejects values outside their range, and non-numeric ports', () => {
    expect(() => loadConfig({ ...valid, PORT: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, PORT: 'http' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, DATABASE_POOL_MAX: '0' })).toThrow(ConfigError);
  });

  it('rejects an unknown NODE_ENV rather than guessing', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'staging' })).toThrow(ConfigError);
    expect(loadConfig({ ...valid, NODE_ENV: 'production' }).isProduction).toBe(true);
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
    const config = loadConfig(valid);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });
});
