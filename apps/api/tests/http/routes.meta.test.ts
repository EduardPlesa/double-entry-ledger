import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRoutes, describeAudit } from '../../src/http/route-audit.js';
import { isPermission } from '../../src/domain/policy.js';
import { allRoutes } from '../../src/routes/index.js';
import { createTestApplication, type TestApplication } from '../helpers/app.js';

/**
 * The meta-test the stage brief asks for: every route registered on the app declares what it
 * requires, and nothing reached the app any other way.
 *
 * A route with no declared permission does not fail closed. It works, returns data, and looks
 * exactly like every other route - there is no runtime symptom, no error in a log, nothing to
 * notice. The only place it can be caught is here, by enumerating what Express actually has
 * and comparing it against what the registry says it should.
 *
 * This asserts the real application is clean. What makes that assertion meaningful is
 * `tests/unit/route-audit.test.ts`, which proves the audit detects a smuggled route, a stale
 * registry row, a double registration and a mounted sub-router - because an audit that
 * detects none of those would pass this test just as happily.
 */

let application: TestApplication;

beforeAll(() => {
  application = createTestApplication();
});

afterAll(async () => {
  await application.close();
});

const definitions = () => allRoutes({ auth: application.auth, books: application.books, ledger: application.ledger });

describe('the registered routes', () => {
  it('match the registry exactly, in both directions', () => {
    const audit = auditRoutes(application.app, definitions());

    // One assertion on the whole audit rather than four, so a failure names every problem at
    // once instead of one per run.
    expect(describeAudit(audit)).toBe('');
  });

  it('are all reachable and all declared', () => {
    const audit = auditRoutes(application.app, definitions());

    expect(audit.undeclared).toEqual([]);
    expect(audit.unregistered).toEqual([]);
    expect(audit.duplicated).toEqual([]);
    expect(audit.opaqueRouters).toBe(0);
    expect(audit.registered.length).toBeGreaterThan(0);
  });
});

describe('every route declares an access requirement', () => {
  it('names a permission that exists in the policy map', () => {
    // A typo here would otherwise produce a permission nothing grants, which fails closed and
    // is therefore survivable - but silently, on one route, until somebody reports it.
    for (const definition of definitions()) {
      if (definition.access.kind !== 'book') continue;

      expect(isPermission(definition.access.permission)).toBe(true);
    }
  });

  it('says how the book is resolved, wherever a permission is checked against one', () => {
    for (const definition of definitions()) {
      if (definition.access.kind !== 'book') continue;

      expect(['param', 'account', 'entry']).toContain(definition.access.bookFrom);

      // A route resolving the book from `:bookId` must actually have one in its path, or the
      // guard would look for a parameter that never arrives and fail at request time.
      if (definition.access.bookFrom === 'param') {
        expect(definition.path).toContain(':bookId');
      }
    }
  });

  it('keeps public routes to the ones that cannot require a credential', () => {
    // The allowlist is written out rather than derived. Making a route public is a decision
    // that should have to be made twice - once in the registry, once here.
    const publicPaths = definitions()
      .filter((definition) => definition.access.kind === 'public')
      .map((definition) => `${definition.method} ${definition.path}`)
      .sort();

    expect(publicPaths).toEqual([
      'get /health',
      'post /auth/login',
      'post /auth/logout',
      'post /auth/refresh',
      'post /auth/register',
    ]);
  });

  it('keeps authenticated-tier routes to the ones no book can be named against', () => {
    // Same reasoning as the public allowlist above, one tier up: `authenticated` skips the
    // membership check entirely, so putting a route there is a decision that should have to be
    // made twice - once in the registry, once here - rather than inherited by whichever route
    // happens to come next.
    const authenticatedPaths = definitions()
      .filter((definition) => definition.access.kind === 'authenticated')
      .map((definition) => `${definition.method} ${definition.path}`)
      .sort();

    expect(authenticatedPaths).toEqual(['get /books', 'post /books']);
  });

  it('gives every route a summary', () => {
    // Stage 7 generates an OpenAPI document from these. A blank summary is a blank entry in
    // the published documentation.
    for (const definition of definitions()) {
      expect(definition.summary.trim().length).toBeGreaterThan(0);
    }
  });
});
