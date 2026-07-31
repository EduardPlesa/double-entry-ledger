import type { Express } from 'express';
import type { RouteDefinition } from '../routes/registry.js';

/**
 * What Express actually has registered, compared against what the registry declares.
 *
 * This exists to back the meta-test, and the meta-test exists because a route with no
 * declared permission is not a route that fails closed - it is a route that works, returns
 * data, and looks exactly like every other route until someone notices. There is no runtime
 * symptom to catch it by. The only place it can be caught is a test that enumerates reality
 * and compares it to intent.
 *
 * Both directions are checked, because each catches a different mistake:
 *
 *   undeclared    a route on the app that the registry has never heard of. The dangerous
 *                 one: something bypassed the table and therefore bypassed authorization.
 *   unregistered  a registry row that no route serves. Harmless in itself, and a reliable
 *                 sign that a route was renamed on one side only - which means the table
 *                 has started drifting away from the thing it claims to describe.
 *
 * A one-directional check would also pass an app that registered the same route twice, where
 * the second registration is unreachable and the first one is doing something nobody is
 * reading.
 */

export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
}

export interface RouteAudit {
  readonly registered: readonly RegisteredRoute[];
  /** On the app, absent from the registry. */
  readonly undeclared: readonly RegisteredRoute[];
  /** In the registry, absent from the app. */
  readonly unregistered: readonly RegisteredRoute[];
  /** Registered more than once, so one of them is unreachable. */
  readonly duplicated: readonly RegisteredRoute[];
  /**
   * Mounted sub-routers, which this cannot see inside of.
   *
   * Reported rather than ignored. Express does not expose a mounted router's path as a
   * string - only as a matcher - so a route inside one cannot be reconstructed reliably, and
   * an audit that silently skipped them would be an audit with a hole exactly where someone
   * wanting to avoid it would put a route. Every route in this application is registered on
   * the app directly, so a non-empty list here is a finding, not a limitation.
   */
  readonly opaqueRouters: number;
}

interface ExpressLayer {
  readonly name?: string;
  readonly route?: { readonly path?: unknown; readonly methods?: Record<string, boolean> };
  readonly handle?: { readonly stack?: unknown };
}

export function registeredRoutes(app: Express): { routes: RegisteredRoute[]; opaqueRouters: number } {
  const routes: RegisteredRoute[] = [];
  let opaqueRouters = 0;

  const stack = (app.router as unknown as { stack?: readonly ExpressLayer[] } | undefined)?.stack ?? [];

  for (const layer of stack) {
    if (layer.route !== undefined) {
      const { path, methods } = layer.route;
      if (typeof path !== 'string' || methods === undefined) continue;

      for (const [method, enabled] of Object.entries(methods)) {
        if (enabled) routes.push({ method: method.toLowerCase(), path });
      }
      continue;
    }

    // A layer whose handle has a stack of its own is a mounted router. Plain middleware -
    // the body parser, the logger - has no stack and is not a route, so it is skipped.
    if (Array.isArray(layer.handle?.stack)) opaqueRouters += 1;
  }

  return { routes, opaqueRouters };
}

export function auditRoutes(app: Express, definitions: readonly RouteDefinition[]): RouteAudit {
  const { routes, opaqueRouters } = registeredRoutes(app);

  const declared = new Set(definitions.map((definition) => key(definition.method, definition.path)));
  const seen = new Map<string, RegisteredRoute>();
  const duplicated: RegisteredRoute[] = [];

  for (const route of routes) {
    const id = key(route.method, route.path);
    if (seen.has(id)) duplicated.push(route);
    else seen.set(id, route);
  }

  return {
    registered: routes,
    undeclared: routes.filter((route) => !declared.has(key(route.method, route.path))),
    unregistered: definitions
      .filter((definition) => !seen.has(key(definition.method, definition.path)))
      .map((definition) => ({ method: definition.method, path: definition.path })),
    duplicated,
    opaqueRouters,
  };
}

function key(method: string, path: string): string {
  return `${method.toLowerCase()} ${path}`;
}

/** A one-line-per-route rendering, so a failing meta-test says what is wrong rather than that something is. */
export function describeAudit(audit: RouteAudit): string {
  const lines: string[] = [];

  for (const route of audit.undeclared) {
    lines.push(`  ${route.method.toUpperCase()} ${route.path} is registered but declares no access requirement`);
  }
  for (const route of audit.unregistered) {
    lines.push(`  ${route.method.toUpperCase()} ${route.path} is declared in the registry but no route serves it`);
  }
  for (const route of audit.duplicated) {
    lines.push(`  ${route.method.toUpperCase()} ${route.path} is registered more than once`);
  }
  if (audit.opaqueRouters > 0) {
    lines.push(`  ${String(audit.opaqueRouters)} mounted sub-router(s): routes inside them cannot be audited`);
  }

  return lines.join('\n');
}
