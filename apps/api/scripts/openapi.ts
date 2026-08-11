/**
 * Writes `docs/openapi.json`.
 *
 * No configuration, no database, no `createApplication`. The document is built from what a
 * route declares - its path, its `access`, its schemas - and never from what its handler
 * does, so the services the handlers close over can be absent. Nothing here calls a handler,
 * and `openapi.test.ts` builds the same document from a fully wired application and compares
 * the two, which is what makes the shortcut safe rather than merely convenient.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../src/openapi/document.js';
import { allRoutes, type RouteDependencies } from '../src/routes/index.js';

const SPEC_PATH = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));

const document = buildOpenApiDocument(allRoutes({} as RouteDependencies));

// Two spaces and a trailing newline, so the committed file diffs a line at a time rather
// than as one enormous string.
await writeFile(SPEC_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

process.stdout.write(`wrote ${SPEC_PATH}\n`);
