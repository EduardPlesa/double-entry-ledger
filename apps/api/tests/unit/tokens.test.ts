import { createHash } from 'node:crypto';
import { newId, testClock } from '@ledger/shared';
import { describe, expect, it } from 'vitest';
import {
  accessTokens,
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
  refreshTokens,
} from '../../src/auth/tokens.js';
import type { AuthConfig } from '../../src/config.js';

const SECRET = 'unit-test-jwt-secret-at-least-32-characters';
const PEPPER = 'unit-test-refresh-pepper-at-least-32-chars';

const START = new Date('2026-03-31T09:00:00.000Z');

const authConfig: AuthConfig = {
  jwtSecret: SECRET,
  jwtIssuer: 'ledger',
  jwtAudience: 'ledger-api',
  accessTokenTtlSeconds: 600,
  refreshTokenPepper: PEPPER,
  refreshTokenTtlSeconds: 2_592_000,
  argon2: { memoryCostKib: 8, timeCost: 1, parallelism: 1 },
};

function issuer(overrides: Partial<AuthConfig> = {}) {
  const clock = testClock(START);
  return { tokens: accessTokens({ config: { ...authConfig, ...overrides }, clock, newId }), clock };
}

describe('access tokens', () => {
  it('round-trips the subject and reports when it expires', async () => {
    const { tokens } = issuer();
    const issued = await tokens.sign('user-1');

    expect(issued.expiresAt.toISOString()).toBe('2026-03-31T09:10:00.000Z');

    const claims = await tokens.verify(issued.token);
    expect(claims?.subject).toBe('user-1');
    expect(claims?.expiresAt.toISOString()).toBe('2026-03-31T09:10:00.000Z');
  });

  it('gives every token its own id', async () => {
    const { tokens } = issuer();
    const [first, second] = await Promise.all([tokens.sign('user-1'), tokens.sign('user-1')]);

    const a = await tokens.verify(first.token);
    const b = await tokens.verify(second.token);

    expect(a?.tokenId).not.toBe(b?.tokenId);
  });

  it('takes both timestamps from the injected clock', async () => {
    // No `new Date()` anywhere in the signing path, and expiry is judged against the same
    // clock - so these assertions do not quietly depend on what today's date happens to be.
    const { tokens, clock } = issuer();
    const issued = await tokens.sign('user-1');

    clock.set(new Date('2026-03-31T09:09:59.000Z'));
    expect(await tokens.verify(issued.token)).not.toBeNull();

    clock.set(new Date('2026-03-31T09:10:01.000Z'));
    expect(await tokens.verify(issued.token)).toBeNull();
  });

  it('refuses a token signed with a different secret', async () => {
    const { tokens } = issuer();
    const other = issuer({ jwtSecret: 'a completely different secret, also 32+ chars' });

    const issued = await other.tokens.sign('user-1');
    expect(await tokens.verify(issued.token)).toBeNull();
  });

  it('refuses a token minted for another issuer or audience', async () => {
    // Both are checked, and both matter the moment a second service signs anything with a
    // shared secret: a token issued for one audience must not authenticate against another.
    const { tokens } = issuer();

    const wrongIssuer = issuer({ jwtIssuer: 'somebody-else' });
    const wrongAudience = issuer({ jwtAudience: 'another-api' });

    expect(await tokens.verify((await wrongIssuer.tokens.sign('user-1')).token)).toBeNull();
    expect(await tokens.verify((await wrongAudience.tokens.sign('user-1')).token)).toBeNull();
  });

  it('refuses an unsigned token that claims alg: none', async () => {
    // The algorithm-confusion attack in its simplest form: strip the signature and tell the
    // verifier there was never meant to be one. The verifier pins HS256 rather than
    // believing the header of the thing it is checking.
    //
    // Assembled by hand because jose will not produce it - which is also how an attacker
    // would have to produce it.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'user-1',
        iss: 'ledger',
        aud: 'ledger-api',
        jti: 'forged',
        exp: Math.floor(START.getTime() / 1000) + 600,
      }),
    ).toString('base64url');

    const { tokens } = issuer();
    expect(await tokens.verify(`${header}.${payload}.`)).toBeNull();
  });

  it('refuses rubbish without throwing', async () => {
    const { tokens } = issuer();

    expect(await tokens.verify('')).toBeNull();
    expect(await tokens.verify('not.a.token')).toBeNull();
    expect(await tokens.verify('Bearer something')).toBeNull();
  });
});

describe('refresh tokens', () => {
  const tokens = refreshTokens(PEPPER);

  it('generates a fresh value each time, with its stored hash', () => {
    const first = tokens.generate();
    const second = tokens.generate();

    expect(first.token).not.toBe(second.token);
    expect(tokens.hash(first.token)).toBe(first.tokenHash);
  });

  it('produces a cookie-safe value with 256 bits behind it', () => {
    const { token } = tokens.generate();

    // base64url of 32 bytes: no padding, and nothing a cookie parser has an opinion about.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically, so a presented token can be looked up by equality', () => {
    const { token, tokenHash } = tokens.generate();

    expect(tokens.hash(token)).toBe(tokenHash);
    expect(tokens.hash(token)).toBe(tokens.hash(token));
  });

  it('is keyed by the pepper, so the stored hash is useless without it', () => {
    // The property that makes a stolen database backup insufficient. A plain SHA-256 of the
    // same token would be reproducible by anyone holding the table.
    const { token, tokenHash } = tokens.generate();
    const elsewhere = refreshTokens('a different pepper entirely, 32+ characters');

    expect(elsewhere.hash(token)).not.toBe(tokenHash);
    expect(createHash('sha256').update(token, 'utf8').digest('hex')).not.toBe(tokenHash);
  });

  it('never stores the token itself', () => {
    const { token, tokenHash } = tokens.generate();
    expect(tokenHash).not.toContain(token);
  });
});

describe('API keys', () => {
  it('carries its environment in the key, where a human can read it', () => {
    expect(generateApiKey('dev').token).toMatch(/^lk_dev_/);
    expect(generateApiKey('test').token).toMatch(/^lk_test_/);
    expect(generateApiKey('live').token).toMatch(/^lk_live_/);
  });

  it('stores a SHA-256 hash and a prefix that identifies without authenticating', () => {
    const key = generateApiKey('dev');

    expect(key.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.tokenHash).toBe(hashApiKey(key.token));

    // Enough to tell two keys apart in a list; nowhere near enough to use.
    expect(key.token.startsWith(key.prefix)).toBe(true);
    expect(key.prefix).toHaveLength('lk_dev_'.length + 6);
    expect(key.prefix.length).toBeLessThan(key.token.length);
  });

  it('generates a distinct key every time', () => {
    const keys = Array.from({ length: 20 }, () => generateApiKey('dev').token);
    expect(new Set(keys).size).toBe(20);
  });

  it('recognises its own shape, so a bad key costs no round trip', () => {
    expect(looksLikeApiKey(generateApiKey('live').token)).toBe(true);
    expect(looksLikeApiKey('lk_dev_short')).toBe(false);
    expect(looksLikeApiKey('sk_live_0000000000000000000000')).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
  });

  it('matches the prefix shape the database will accept', () => {
    // api_keys_prefix_shape, from migration 0004. A generator that drifted from the CHECK
    // would fail at the INSERT, on the one request that was issuing a key.
    for (const environment of ['dev', 'test', 'live'] as const) {
      expect(generateApiKey(environment).prefix).toMatch(/^lk_[a-z]+_/);
    }
  });
});
