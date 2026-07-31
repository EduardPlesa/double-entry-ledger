import { defineConfig } from 'vitest/config';

/**
 * Two projects, because two kinds of test.
 *
 * `unit` is pure computation - configuration parsing, the policy map, hashing, token
 * encoding - and needs nothing but Node. `integration` needs a real Postgres, which means
 * a container, which means a Docker daemon and about seven seconds before the first
 * assertion runs.
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
    ],
  },
});
