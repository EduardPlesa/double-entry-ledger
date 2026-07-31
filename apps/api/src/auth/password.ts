import { hash, verify } from '@node-rs/argon2';
import type { Argon2Config } from '../config.js';

/**
 * `Algorithm.Argon2id` by value.
 *
 * The library declares `Algorithm` as an ambient `const enum`, which `verbatimModuleSyntax`
 * refuses to read - a const enum has no runtime representation to import. The number is
 * pinned here with the assertion below rather than left to the library's default, because
 * the choice of argon2id over argon2i or argon2d is the security-relevant decision in this
 * file and it should be visible, not inherited.
 */
const ARGON2ID = 2;

/**
 * Password hashing, as an interface the auth service receives rather than a module it
 * imports.
 *
 * argon2id at production cost is deliberately slow - that is the entire feature - which
 * makes it something a test suite cannot afford to pay a hundred times. Injecting it means
 * a test can hand over the same implementation with cheap parameters, or a stub, without
 * anything in the service changing or knowing.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;

  /**
   * Verifies a password against a stored hash, where `storedHash` may be null.
   *
   * The null case is the point. Logging in with an email nobody has registered must take the
   * same time as logging in with the wrong password, or the login endpoint answers "does
   * this person have an account here" to anyone with a stopwatch - which for a lot of
   * services is a more sensitive question than the password itself. Handling it here rather
   * than in the caller means there is one place to get it right, and no way to write the
   * obvious `if (user === null) return false` by accident.
   */
  verify(storedHash: string | null, password: string): Promise<boolean>;
}

/**
 * Something to verify against when there is no user. Its value is irrelevant - it must
 * simply be a real hash under the same parameters, so that verifying it costs what verifying
 * a real one costs.
 */
const DUMMY_PASSWORD = 'there is no user with this email address';

export function argon2idHasher(config: Argon2Config): PasswordHasher {
  const options = {
    algorithm: ARGON2ID,
    memoryCost: config.memoryCostKib,
    timeCost: config.timeCost,
    parallelism: config.parallelism,
  };

  // Computed once, on first use rather than at construction: building the hasher is not an
  // operation that should block on a deliberately slow hash, and a process that never
  // handles a failed login never pays for it at all.
  let dummyHash: Promise<string> | undefined;

  return {
    async hash(password: string): Promise<string> {
      return hash(password, options);
    },

    async verify(storedHash: string | null, password: string): Promise<boolean> {
      if (storedHash === null) {
        dummyHash ??= hash(DUMMY_PASSWORD, options);
        await verify(await dummyHash, password);
        return false;
      }

      try {
        return await verify(storedHash, password);
      } catch {
        // A stored hash that argon2 cannot parse is a corrupt row, not a correct password.
        // Rethrowing would turn one bad row into a 500 on a login attempt, and there is
        // nothing the caller could do differently.
        return false;
      }
    },
  };
}
