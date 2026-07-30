import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const MIGRATIONS_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * Applies pending migrations as the schema owner. Exported so the integration test
 * harness can migrate a throwaway container through exactly the same code path the dev
 * database uses - a migration that only ever runs one way is a migration nobody has
 * tested.
 */
export async function runMigrations(migrationUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // The connection string comes from the config module, like every other environment
  // variable in the application, and the `.env` file itself is loaded by Node via
  // `--env-file-if-exists` in the package script. Note which URL: migrations run as
  // ledger_owner, the role the application never holds.
  const { getConfig } = await import('../config.js');

  await runMigrations(getConfig().database.migrationUrl);
  console.log('migrations applied');
}
