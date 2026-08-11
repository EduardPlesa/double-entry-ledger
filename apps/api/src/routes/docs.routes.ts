import type { RequestHandler } from 'express';
import { z } from 'zod';
import { buildOpenApiDocument } from '../openapi/document.js';
import type { RouteDefinition } from './registry.js';

/**
 * The spec, and a page that renders it.
 *
 * Both are public. A specification that requires a credential to read is a specification
 * nobody reads, and there is nothing in it that is not already discoverable by anyone holding
 * one - it describes shapes, not data.
 *
 * The definitions arrive as a function rather than an array because these two routes are
 * themselves in the registry, and a list cannot contain something built from itself. It is
 * called once, on the first request, and the document is kept: it is derived from a table
 * that cannot change while the process is running.
 */

export interface DocsRouteDependencies {
  /** Every route in the application, this pair included. */
  readonly definitions: () => readonly RouteDefinition[];
}

/**
 * Loose, because the response is an OpenAPI document and this is not the place to re-specify
 * one. `openapi` is asserted so the route cannot silently start serving something else.
 */
const openApiDocument = z.looseObject({ openapi: z.string() });

export function docsRoutes(dependencies: DocsRouteDependencies): RouteDefinition[] {
  let document: unknown;

  const built = () => {
    document ??= buildOpenApiDocument(dependencies.definitions());
    return document;
  };

  const serveDocument: RequestHandler = (_request, response) => {
    response.json(built());
  };

  const servePage: RequestHandler = (_request, response) => {
    response.type('html').send(PAGE);
  };

  return [
    {
      method: 'get',
      path: '/docs/openapi.json',
      access: { kind: 'public' },
      summary: 'The OpenAPI document for this API',
      response: { status: 200, schema: openApiDocument },
      handler: serveDocument,
    },
    {
      method: 'get',
      path: '/docs',
      access: { kind: 'public' },
      summary: 'An HTML page rendering the OpenAPI document',
      response: { status: 200 },
      handler: servePage,
    },
  ];
}

/**
 * Scalar, from a CDN, pointed at the JSON route.
 *
 * The cost, stated plainly: this page needs network access to a third party to render, so it
 * is blank on an air-gapped machine and its contents are outside this repository's control.
 * `/docs/openapi.json` and `docs/openapi.json` both work with neither, and they are the
 * artefacts that matter - this is a convenience on top of them, not the documentation itself.
 */
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ledger API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/docs/openapi.json' });
    </script>
  </body>
</html>
`;
