import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
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
});
