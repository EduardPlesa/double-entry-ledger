import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_SQL = path.resolve(HERE, '../../../../docker/initdb/00-bootstrap-roles.sql');

let container: StartedPostgreSqlContainer | undefined;

declare module 'vitest' {
  interface ProvidedContext {
    /** ledger_owner: owns the schema. Used to prove the triggers fire even for a role
     *  that has not had UPDATE and DELETE revoked. */
    ownerUrl: string;
    /** ledger_app: the runtime role. SELECT and INSERT only. */
    appUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('ledger')
    .withUsername('postgres')
    .withPassword('postgres')
    // The same bootstrap file docker-compose mounts. Provisioning dev and test databases
    // from one script is the only way the privilege tests below mean anything about the
    // database you actually develop against.
    .withCopyFilesToContainer([
      { source: BOOTSTRAP_SQL, target: '/docker-entrypoint-initdb.d/00-bootstrap-roles.sql' },
    ])
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  const ownerUrl = `postgres://ledger_owner:ledger_owner_dev@${host}:${port}/ledger`;
  const appUrl = `postgres://ledger_app:ledger_app_dev@${host}:${port}/ledger`;

  await runMigrations(ownerUrl);

  project.provide('ownerUrl', ownerUrl);
  project.provide('appUrl', appUrl);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
