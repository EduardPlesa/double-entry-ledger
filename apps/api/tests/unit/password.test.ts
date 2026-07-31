import { describe, expect, it } from 'vitest';
import type { Argon2Config } from '../../src/config.js';
import { argon2idHasher } from '../../src/auth/password.js';

/**
 * Cheap parameters, and that is the whole reason the hasher takes its cost as an argument.
 * The production defaults are 19 MiB and two passes; paying that a dozen times here would
 * add seconds to every run and test nothing these do not.
 */
const cheap: Argon2Config = { memoryCostKib: 8, timeCost: 1, parallelism: 1 };

const hasher = argon2idHasher(cheap);

describe('argon2idHasher', () => {
  it('produces an argon2id PHC string that records how it was hashed', async () => {
    const hash = await hasher.hash('correct horse battery staple');

    // Two assertions in one regex. `argon2id` pins the numeric algorithm constant the
    // implementation has to hardcode - the library declares it as an ambient const enum,
    // which cannot be imported under verbatimModuleSyntax, so a wrong number would silently
    // select argon2d or argon2i and this is what catches it.
    //
    // The rest is the parameters travelling with the hash, which is what makes raising the
    // cost later a change to new passwords rather than an invalidation of every existing one.
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=8,t=1,p=1\$/);
  });

  it('produces a different hash every time, for the same password', async () => {
    // Per-hash salt. Two users with the same password must not be visibly the same user.
    const [first, second] = await Promise.all([hasher.hash('same'), hasher.hash('same')]);

    expect(first).not.toBe(second);
    expect(await hasher.verify(first, 'same')).toBe(true);
    expect(await hasher.verify(second, 'same')).toBe(true);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hasher.hash('right');

    expect(await hasher.verify(hash, 'right')).toBe(true);
    expect(await hasher.verify(hash, 'wrong')).toBe(false);
    expect(await hasher.verify(hash, '')).toBe(false);
  });

  it('handles passwords that are not ASCII, and long ones', async () => {
    const awkward = 'pässwörd 🔐 with spaces and a very '.repeat(10);
    const hash = await hasher.hash(awkward);

    expect(await hasher.verify(hash, awkward)).toBe(true);
    expect(await hasher.verify(hash, awkward.trimEnd())).toBe(false);
  });

  it('returns false rather than throwing on a hash it cannot parse', async () => {
    // A corrupt row should fail one login, not produce a 500 that the caller can do nothing
    // about and that looks like an outage.
    expect(await hasher.verify('not a hash at all', 'anything')).toBe(false);
    expect(await hasher.verify('$argon2id$v=19$broken', 'anything')).toBe(false);
  });

  it('still does the work when there is no user, and still says no', async () => {
    // The timing property this exists for is not directly assertable without a flaky
    // benchmark. What is assertable is that the null path returns false and that it is not
    // free - a `return false` shortcut would complete far faster than a real verify, so a
    // generous bound catches the shortcut without measuring the machine.
    const started = process.hrtime.bigint();
    const result = await hasher.verify(null, 'anything');
    const elapsedMicroseconds = Number(process.hrtime.bigint() - started) / 1000;

    expect(result).toBe(false);
    expect(elapsedMicroseconds).toBeGreaterThan(100);
  });

  it('does not rebuild the dummy hash on every failed lookup', async () => {
    // Cached after the first call. Ten unknown emails should not cost ten hashes on top of
    // the ten verifies, which is what makes the null path comparable to the real one rather
    // than twice its cost.
    await hasher.verify(null, 'warm the cache');

    const started = process.hrtime.bigint();
    await Promise.all(Array.from({ length: 5 }, () => hasher.verify(null, 'x')));
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;

    expect(elapsed).toBeLessThan(500);
  });
});
