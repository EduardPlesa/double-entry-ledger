import { describe, expect, it } from 'vitest';
import { fixedClock, systemClock, testClock } from './clock.js';

describe('fixedClock', () => {
  it('stops at the given instant', () => {
    const clock = fixedClock(new Date('2026-03-31T12:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-03-31T12:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-03-31T12:00:00.000Z');
  });

  it('hands out a fresh Date, so a caller cannot mutate the clock', () => {
    const clock = fixedClock(new Date('2026-03-31T12:00:00.000Z'));
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-03-31T12:00:00.000Z');
  });
});

describe('testClock', () => {
  it('moves only when told to', () => {
    const clock = testClock(new Date('2026-03-31T12:00:00.000Z'));
    clock.advance(1000);
    expect(clock.now().toISOString()).toBe('2026-03-31T12:00:01.000Z');

    clock.advance(-1000);
    expect(clock.now().toISOString()).toBe('2026-03-31T12:00:00.000Z');

    clock.set(new Date('2020-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('systemClock', () => {
  it('reads the wall clock', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
