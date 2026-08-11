import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/openapi/document.js';
import { acceptsIdempotencyKey } from '../../src/routes/registry.js';
import { allRoutes } from '../../src/routes/index.js';
import { createTestApplication, type TestApplication } from '../helpers/app.js';

/**
 * The document is generated from the registry, so what is worth testing is the derivation:
 * that every route reached it, that a credential requirement follows from `access` rather
 * than from someone remembering to write one, and that the header a route honours and the
 * header the spec advertises are the same set.
 *
 * The shapes themselves are not re-asserted here. `contracts.test.ts` already checks real
 * responses against the schemas this document publishes, which is the same fact from the
 * other end.
 */

let application: TestApplication;

beforeAll(() => {
  application = createTestApplication();
});

afterAll(async () => {
  await application.close();
});

const definitions = () =>
  allRoutes({ auth: application.auth, books: application.books, ledger: application.ledger });

/** Express ':bookId' is OpenAPI '{bookId}'. */
const asOpenApiPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');

describe('the generated document', () => {
  it('has a path for every registered route', () => {
    const document = buildOpenApiDocument(definitions());

    for (const definition of definitions()) {
      expect(
        document.paths[asOpenApiPath(definition.path)]?.[definition.method],
        `${definition.method} ${definition.path}`,
      ).toBeDefined();
    }
  });

  it('requires no credential on a public route and one everywhere else', () => {
    const document = buildOpenApiDocument(definitions());
    const login = document.paths['/auth/login']?.post;
    const entries = document.paths['/books/{bookId}/entries']?.post;

    expect(login?.security).toEqual([]);
    expect(entries?.security?.length).toBeGreaterThan(0);
  });

  it('names the refresh cookie on the one route that reads it', () => {
    // `access: 'public'` is a true statement about what the guards check and a false one about
    // what the endpoint needs. The cookie is the credential here, and the spec says so.
    const document = buildOpenApiDocument(definitions());

    expect(document.paths['/auth/refresh']?.post?.security).toEqual([{ refreshCookie: [] }]);
  });

  it('documents Idempotency-Key on exactly the routes that honour it', () => {
    const document = buildOpenApiDocument(definitions());

    for (const definition of definitions()) {
      const operation = document.paths[asOpenApiPath(definition.path)]?.[definition.method];
      const declared = (operation?.parameters ?? []).some(
        (parameter) => parameter.name === 'Idempotency-Key',
      );

      expect(declared, `${definition.method} ${definition.path}`).toBe(
        acceptsIdempotencyKey(definition),
      );
    }
  });

  it('lists every path parameter, and marks it required', () => {
    const document = buildOpenApiDocument(definitions());
    const parameters = document.paths['/accounts/{accountId}/balance']?.get?.parameters ?? [];
    const accountId = parameters.find((parameter) => parameter.name === 'accountId');

    expect(accountId?.in).toBe('path');
    expect(accountId?.required).toBe(true);
    expect(parameters.some((parameter) => parameter.name === 'asOf' && parameter.in === 'query')).toBe(true);
  });

  it('describes the problem shape once and references it', () => {
    const document = buildOpenApiDocument(definitions());
    const entries = document.paths['/books/{bookId}/entries']?.post;

    expect(document.components.schemas.Problem).toBeDefined();
    expect(entries?.responses['422']).toBeDefined();
    expect(entries?.responses['404']).toBeDefined();
    expect(entries?.responses['401']).toBeDefined();
  });

  it('publishes a resource once and refers to it from every route that returns one', () => {
    const document = buildOpenApiDocument(definitions());
    const entry = document.paths['/entries/{entryId}']?.get?.responses['200'];

    expect(document.components.schemas.Entry).toBeDefined();
    expect(entry?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/Entry',
    });
  });
});
