import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Clock } from '@ledger/shared';
import { SignJWT, jwtVerify } from 'jose';
import type { ApiKeyEnvironment, AuthConfig } from '../config.js';

/**
 * The three credentials this system issues, and the crypto behind each.
 *
 * All pure: no database, no Express, no domain errors. Verification returns null rather than
 * throwing, because "this token is not valid" is an ordinary answer here and only becomes a
 * 401 several layers up, where something knows what HTTP is.
 *
 * The three are deliberately different shapes, because they answer different questions:
 *
 *   access token   a signed assertion, verified without any lookup, short-lived because
 *                  nothing can revoke it
 *   refresh token  an opaque random value, verified by looking up a keyed hash, revocable
 *                  precisely because the lookup exists
 *   API key        an opaque random value with a readable prefix, verified by looking up an
 *                  unkeyed hash
 *
 * Why the refresh token's stored hash is keyed with a pepper and the API key's is not: both
 * are 256 bits of CSPRNG output, so neither needs a slow hash and neither has a dictionary
 * to mount. The refresh token is peppered because it is the credential a stolen database
 * backup would otherwise let an attacker use directly against the refresh endpoint, and the
 * pepper lives somewhere the backup does not. Rotating it invalidates every session at once,
 * which is the intended emergency lever.
 */

const RANDOM_BYTES = 32;

export interface AccessTokenClaims {
  /** The user id. */
  readonly subject: string;
  /** This token's own id, so a specific token can be named in a log line. */
  readonly tokenId: string;
  readonly expiresAt: Date;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AccessTokens {
  sign(subject: string): Promise<IssuedAccessToken>;
  /** The claims, or null if the token is missing, malformed, expired, or not ours. */
  verify(token: string): Promise<AccessTokenClaims | null>;
}

export interface AccessTokensDependencies {
  readonly config: AuthConfig;
  readonly clock: Clock;
  readonly newId: () => string;
}

export function accessTokens(dependencies: AccessTokensDependencies): AccessTokens {
  const { config, clock, newId } = dependencies;
  const key = new TextEncoder().encode(config.jwtSecret);

  return {
    async sign(subject: string): Promise<IssuedAccessToken> {
      const issuedAt = clock.now();
      const expiresAt = new Date(issuedAt.getTime() + config.accessTokenTtlSeconds * 1000);

      const token = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(subject)
        .setIssuer(config.jwtIssuer)
        .setAudience(config.jwtAudience)
        .setJti(newId())
        .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
        .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
        .sign(key);

      return { token, expiresAt };
    },

    async verify(token: string): Promise<AccessTokenClaims | null> {
      try {
        const { payload } = await jwtVerify(token, key, {
          issuer: config.jwtIssuer,
          audience: config.jwtAudience,

          // Pinned, and not negotiable from the token. A verifier that takes the algorithm
          // from the header it is checking is the algorithm-confusion bug, and it has been
          // found in more JWT libraries than have avoided it.
          algorithms: ['HS256'],

          // Expiry is judged against the injected clock, not the wall clock, so a test with
          // a stopped clock gets deterministic answers about expiry instead of answers that
          // depend on what today's date happens to be.
          currentDate: clock.now(),
        });

        if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null;
        if (typeof payload.exp !== 'number') return null;

        return {
          subject: payload.sub,
          tokenId: payload.jti,
          expiresAt: new Date(payload.exp * 1000),
        };
      } catch {
        // jose distinguishes expired from malformed from wrong-signature. The caller does
        // not get to: telling someone which of those they achieved is free information about
        // how close they are.
        return null;
      }
    },
  };
}

export interface GeneratedRefreshToken {
  /** Sent to the client, in the cookie. Never stored. */
  readonly token: string;
  /** Stored. Never sent. */
  readonly tokenHash: string;
}

export interface RefreshTokens {
  generate(): GeneratedRefreshToken;
  /** The stored form of a presented token, for looking the row up by equality. */
  hash(token: string): string;
}

export function refreshTokens(pepper: string): RefreshTokens {
  const hash = (token: string): string =>
    createHmac('sha256', pepper).update(token, 'utf8').digest('hex');

  return {
    generate(): GeneratedRefreshToken {
      // base64url, so the value survives a Set-Cookie header untouched: no padding, no
      // characters a cookie parser has an opinion about.
      const token = randomBytes(RANDOM_BYTES).toString('base64url');
      return { token, tokenHash: hash(token) };
    },
    hash,
  };
}

export interface GeneratedApiKey {
  /** Returned to the caller once, at issuance, and never recoverable afterwards. */
  readonly token: string;
  readonly tokenHash: string;
  /** Safe to display and to store alongside the hash. Identifies without authenticating. */
  readonly prefix: string;
}

/** How much of the random part the displayable prefix keeps. */
const PREFIX_RANDOM_CHARS = 6;

/**
 * `lk_<env>_<random>`.
 *
 * The environment label is in the key itself so that a key pasted into the wrong system is
 * recognisable as wrong by a human reading it, and greppable in a log by a machine. The
 * scheme prefix is there so that a leaked key is detectable by a secret scanner, which is
 * the entire reason every provider's keys start with a fixed string.
 */
export function generateApiKey(environment: ApiKeyEnvironment): GeneratedApiKey {
  const random = randomBytes(RANDOM_BYTES).toString('base64url');
  const token = `lk_${environment}_${random}`;

  return {
    token,
    tokenHash: hashApiKey(token),
    prefix: `lk_${environment}_${random.slice(0, PREFIX_RANDOM_CHARS)}`,
  };
}

/**
 * SHA-256, hex. Unkeyed and fast on purpose: this runs on every machine-client request, and
 * the value being hashed is already 256 bits of randomness, so there is nothing for a slow
 * hash to defend against.
 */
export function hashApiKey(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether a string is shaped like one of our keys. Cheap enough to skip a database round trip. */
export function looksLikeApiKey(value: string): boolean {
  return /^lk_[a-z]+_[A-Za-z0-9_-]{16,}$/.test(value);
}
