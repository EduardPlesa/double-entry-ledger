import type { Express, RequestHandler } from 'express';
import { pino } from 'pino';
import { createApp } from '../../src/http/app.js';
import type { RouteDefinition } from '../../src/routes/registry.js';

/**
 * An app with whatever routes a test wants, and nothing it does not.
 *
 * The guards are a parameter because most of these tests are about the pipeline - problem
 * documents, request ids, the 404 handler - and wiring real authentication into them would
 * mean every assertion about an error document also depended on a token being valid.
 */

/** Silent by default: a passing test that prints a hundred JSON log lines is a test nobody reads. */
export function testLogger() {
  return pino({ level: 'silent' });
}

/** Guards that permit everything. The access requirement is enforced in its own tests. */
export const permissiveGuards = (_definition: RouteDefinition): readonly RequestHandler[] => [];

export interface TestAppOptions {
  readonly definitions: readonly RouteDefinition[];
  readonly guards?: (definition: RouteDefinition) => readonly RequestHandler[];
  readonly exposeInternalErrors?: boolean;
  /**
   * Routes registered directly on the app, behind the registry's back.
   *
   * Exists for exactly one test: proving the meta-test notices. A helper that could not
   * express the mistake could not be used to demonstrate that the mistake is caught.
   */
  readonly rogueRoutes?: readonly { method: 'get' | 'post'; path: string }[];
}

export function createTestApp(options: TestAppOptions): Express {
  const app = createApp({
    definitions: options.definitions,
    guards: options.guards ?? permissiveGuards,
    logger: testLogger(),
    ...(options.exposeInternalErrors === undefined
      ? {}
      : { exposeInternalErrors: options.exposeInternalErrors }),
  });

  return app;
}

/**
 * Builds an app and smuggles extra routes onto it.
 *
 * Registered before `createApp` would add its 404 handler, so they are reachable - which is
 * what makes them dangerous in the first place and what the audit has to catch.
 */
export function createAppWithRogueRoutes(
  definitions: readonly RouteDefinition[],
  rogue: readonly { method: 'get' | 'post'; path: string }[],
): Express {
  const app = createApp({
    definitions,
    guards: permissiveGuards,
    logger: testLogger(),
  });

  for (const route of rogue) {
    app[route.method](route.path, (_request, response) => {
      response.json({ smuggled: true });
    });
  }

  return app;
}

export function route(overrides: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    method: 'get',
    path: '/probe',
    access: { kind: 'public' },
    summary: 'a route that exists only for this test',
    handler: (_request, response) => {
      response.json({ ok: true });
    },
    ...overrides,
  };
}
