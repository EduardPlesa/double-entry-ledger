import express from 'express';
import { describe, expect, it } from 'vitest';
import { auditRoutes, describeAudit, registeredRoutes } from '../../src/http/route-audit.js';
import { createAppWithRogueRoutes, createTestApp, route } from '../helpers/http.js';

/**
 * The meta-test's machinery, tested against apps built to be wrong.
 *
 * The meta-test itself asserts that the real application is clean, which is the assertion
 * that matters - and which passes just as happily if the audit is broken and reports nothing.
 * These are what make that assertion mean something: an audit that cannot detect a smuggled
 * route is an audit that will never detect one.
 */

const definitions = [
  route({ method: 'get', path: '/probe' }),
  route({ method: 'post', path: '/books/:bookId/entries' }),
];

describe('registeredRoutes', () => {
  it('enumerates what Express actually has, with path patterns intact', () => {
    const app = createTestApp({ definitions });
    const { routes } = registeredRoutes(app);

    expect(routes).toEqual([
      { method: 'get', path: '/probe' },
      { method: 'post', path: '/books/:bookId/entries' },
    ]);
  });

  it('does not mistake middleware for a route', () => {
    // The body parser, the logger and the cookie parser are all layers on the same stack.
    // An audit that counted them would report a dozen undeclared routes on every run and be
    // switched off within a week.
    const app = createTestApp({ definitions: [] });
    expect(registeredRoutes(app).routes).toEqual([]);
  });
});

describe('auditRoutes', () => {
  it('passes an app whose routes match the registry exactly', () => {
    const audit = auditRoutes(createTestApp({ definitions }), definitions);

    expect(audit.undeclared).toEqual([]);
    expect(audit.unregistered).toEqual([]);
    expect(audit.duplicated).toEqual([]);
    expect(audit.opaqueRouters).toBe(0);
  });

  it('catches a route smuggled onto the app behind the registry', () => {
    // The failure this whole mechanism exists for. A route registered directly has no
    // declared permission, so nothing enforces one - and it works perfectly, returns data,
    // and looks like every other route until somebody reads the file.
    const app = createAppWithRogueRoutes(definitions, [{ method: 'get', path: '/secret' }]);
    const audit = auditRoutes(app, definitions);

    expect(audit.undeclared).toEqual([{ method: 'get', path: '/secret' }]);
    expect(describeAudit(audit)).toContain('GET /secret is registered but declares no access requirement');
  });

  it('catches a registry row that no route serves', () => {
    // Harmless on its own, and a reliable sign the table has started describing something
    // other than the application - usually a rename applied on one side only.
    const app = createTestApp({ definitions });
    const audit = auditRoutes(app, [...definitions, route({ method: 'get', path: '/renamed' })]);

    expect(audit.unregistered).toEqual([{ method: 'get', path: '/renamed' }]);
  });

  it('catches the same route registered twice', () => {
    // Both are declared, so a one-directional check passes. One of them is unreachable, and
    // whichever it is, somebody is maintaining a handler that never runs.
    const app = createAppWithRogueRoutes(definitions, [{ method: 'get', path: '/probe' }]);
    const audit = auditRoutes(app, definitions);

    expect(audit.undeclared).toEqual([]);
    expect(audit.duplicated).toEqual([{ method: 'get', path: '/probe' }]);
  });

  it('reports a mounted sub-router rather than quietly skipping it', () => {
    // Express exposes a mount path as a matcher, not a string, so routes inside cannot be
    // reconstructed. Silently ignoring them would leave a hole exactly where someone wanting
    // to avoid the audit would put a route.
    const app = createTestApp({ definitions });
    const nested = express.Router();
    nested.get('/inside', (_request, response) => {
      response.end();
    });
    app.use('/mounted', nested);

    const audit = auditRoutes(app, definitions);

    expect(audit.opaqueRouters).toBe(1);
    expect(describeAudit(audit)).toContain('cannot be audited');
  });

  it('reports every finding at once, not the first', () => {
    const app = createAppWithRogueRoutes(definitions, [{ method: 'post', path: '/also-secret' }]);
    const audit = auditRoutes(app, [...definitions, route({ method: 'get', path: '/renamed' })]);

    const description = describeAudit(audit);
    expect(description).toContain('/also-secret');
    expect(description).toContain('/renamed');
  });
});
