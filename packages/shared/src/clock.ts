/**
 * Time, as a dependency.
 *
 * Services take a Clock and call `clock.now()`. Nothing below the HTTP layer calls
 * `new Date()`, which is what makes "an entry recorded at T sorts before one recorded at
 * T+1" a thing a test can state rather than a thing a test has to hope for. The rule is
 * enforced by review, not by a lint rule, because `new Date(someString)` is a legitimate
 * parse and only the zero-argument form is a hidden read of the system clock.
 *
 * `occurred_at` is never read from a Clock - it is when the transaction happened in the
 * world, which the caller asserts. Only `recorded_at`, when we learned of it, comes from
 * here.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock stopped at an instant. Returns a fresh Date each call, so callers cannot mutate it. */
export function fixedClock(instant: Date): Clock {
  const millis = instant.getTime();
  return { now: () => new Date(millis) };
}

export interface TestClock extends Clock {
  /** Moves the clock forward. Negative values are allowed; time occasionally goes backwards. */
  advance(millis: number): void;
  set(instant: Date): void;
}

/** A clock a test drives by hand, for asserting on ordering and on `asOf` boundaries. */
export function testClock(start: Date): TestClock {
  let millis = start.getTime();
  return {
    now: () => new Date(millis),
    advance: (delta) => {
      millis += delta;
    },
    set: (instant) => {
      millis = instant.getTime();
    },
  };
}
