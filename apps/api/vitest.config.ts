import { defineConfig } from 'vitest/config';

/**
 * Four projects, because four kinds of test.
 *
 * `unit` is pure computation - configuration parsing, the policy map, hashing, token
 * encoding - and needs nothing but Node. `integration` needs a real Postgres, which means
 * a container, which means a Docker daemon and about seven seconds before the first
 * assertion runs. `concurrency` also needs that container, but not the single-worker
 * discipline `integration` runs under: its tests are the ones firing overlapping
 * transactions at the same pool on purpose, so it gets its own process pool instead.
 *
 * `properties` needs the same container as `integration` and the same single-worker
 * discipline, but not its budget: a property run is tens of seconds where an integration file
 * is a second. Folding it in would make every run of the suite people execute while editing
 * pay for it, and the pressure would then be to shrink `numRuns` until the properties stopped
 * being properties.
 *
 * Keeping them apart is not tidiness. A single project means a global setup that starts a
 * container for every run, so checking whether a regex is right requires Docker to be up -
 * and a test suite you cannot run is a test suite that stops being run.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/{db,services,http}/**/*.test.ts'],
          globalSetup: ['./tests/setup/postgres.global.ts'],

          // Starting a Postgres container and migrating it is slower than a unit test by two
          // orders of magnitude. These are the real numbers, not padding.
          testTimeout: 30_000,
          hookTimeout: 120_000,

          // Every test file shares one container, and this database physically cannot be
          // truncated between files. Tests isolate themselves by creating their own book
          // instead, but running them in a single process keeps failures readable and
          // connection counts sane.
          pool: 'threads',
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        test: {
          name: 'concurrency',
          include: ['tests/concurrency/**/*.test.ts'],
          globalSetup: ['./tests/setup/postgres.global.ts'],

          testTimeout: 60_000,
          hookTimeout: 120_000,

          // Genuinely concurrent connections are the subject, so these cannot share the
          // single-worker discipline of the integration project: every test here opens its
          // own pool and fires overlapping transactions through it. One file at a time, so
          // two files are never contending for the same container's connection slots.
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        test: {
          name: 'properties',
          include: ['tests/properties/**/*.test.ts'],
          globalSetup: ['./tests/setup/postgres.global.ts'],

          // A single case is a book seed plus a few dozen round trips, and a run is dozens of
          // cases. This is the real number, not padding.
          testTimeout: 180_000,
          hookTimeout: 120_000,

          // Same discipline as `integration`: one book per case is what isolates these, and a
          // single worker keeps failures readable and connection counts sane.
          pool: 'threads',
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
