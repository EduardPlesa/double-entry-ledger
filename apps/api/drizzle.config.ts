import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

// Tooling config, not runtime code: drizzle-kit runs this in its own process, before any
// application module is loaded. Stage 2's "process.env is read in exactly one place" rule
// covers the running server; the ESLint rule added there exempts this file.
//
// Note the URL: schema changes are applied as ledger_owner. The runtime role cannot alter
// the schema at all, which is what stops an application-level bug from ever being able to
// drop the invariant triggers.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? '',
  },
  strict: true,
  verbose: true,
});
