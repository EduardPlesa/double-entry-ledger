import { newId } from '@ledger/shared';
import cookieParser from 'cookie-parser';
import express, { type Express, type RequestHandler } from 'express';
import type { Logger } from 'pino';
import type { RouteAccess, RouteDefinition } from '../routes/registry.js';
import { errorMiddleware } from './error-middleware.js';
import { httpLogger } from './logger.js';
import { PROBLEM_CONTENT_TYPE, problem } from './problem.js';
import { requestIdMiddleware, requestIdOf } from './request-id.js';

/**
 * The Express application.
 *
 * A factory, not a module-level `const app`. An app built at import time is an app that
 * cannot be built twice with different dependencies, which means a test either shares one
 * with every other test or does not exist.
 */

/** 256 KiB. An entry with a thousand legs is nowhere near this; anything larger is a mistake or an attack. */
const BODY_LIMIT = '256kb';

export interface AppDependencies {
  readonly definitions: readonly RouteDefinition[];

  /**
   * The middleware that enforces a route's access requirement.
   *
   * Passed in rather than imported, and this is the seam the whole registry rests on:
   * `app.ts` knows that every route has an `access` and that something must enforce it, and
   * knows nothing about tokens, roles or books. Authentication and authorization are wired
   * here, once, for every route in the table - there is no per-route opportunity to forget.
   */
  readonly guards: (access: RouteAccess) => readonly RequestHandler[];

  readonly logger: Logger;
  readonly exposeInternalErrors?: boolean;
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express();

  // No `X-Powered-By: Express`. It tells an attacker which CVE list to read and tells nobody
  // else anything at all.
  app.disable('x-powered-by');

  // Strict routing off, so `/books` and `/books/` are one route rather than two that can
  // drift apart - including in the meta-test, which would otherwise have to know about both.
  app.set('strict routing', false);

  // The same id source as everything else in the system: uuid v7, which is time-ordered, so
  // request ids sort chronologically in a log viewer that knows nothing about timestamps.
  app.use(requestIdMiddleware(newId));
  app.use(httpLogger(dependencies.logger));

  app.use(
    express.json({
      limit: BODY_LIMIT,
      // The raw bytes, kept for the idempotency fingerprint. Hashing the parsed object would
      // mean hashing whatever key order and number formatting the parser happened to produce;
      // hashing the bytes the client actually sent is the only version of "the same request"
      // that both sides can agree on.
      verify: (request, _response, buffer) => {
        (request as { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.use(cookieParser());

  for (const definition of dependencies.definitions) {
    app[definition.method](definition.path, ...dependencies.guards(definition.access), definition.handler);
  }

  // Unmatched paths, as a problem document like everything else. Without this, Express's
  // default handler answers with an HTML page, which is a surprising thing for a JSON API to
  // hand a client that is already confused about a URL.
  app.use((request, response) => {
    response
      .status(404)
      .type(PROBLEM_CONTENT_TYPE)
      .json(
        problem({
          status: 404,
          title: 'Route not found',
          detail: `${request.method} ${request.path} is not a route this API serves`,
          code: 'ROUTE_NOT_FOUND',
          instance: request.originalUrl,
          requestId: requestIdOf(response),
        }),
      );
  });

  app.use(errorMiddleware({ exposeInternalErrors: dependencies.exposeInternalErrors ?? false }));

  return app;
}
