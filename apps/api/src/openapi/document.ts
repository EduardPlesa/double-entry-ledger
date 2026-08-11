import {
  accountList,
  accountResource,
  balanceResource,
  bookList,
  bookResource,
  createAccountInput,
  createBookInput,
  credentials,
  entryResource,
  issuedApiKeyResource,
  membershipResource,
  postEntryInput,
  postingPageResource,
  reverseEntryInput,
  sessionResource,
  trialBalanceResource,
} from '@ledger/shared';
import { z } from 'zod';
import { PROBLEM_CONTENT_TYPE } from '../http/problem.js';
import { acceptsIdempotencyKey, type RouteDefinition, type RouteMethod } from '../routes/registry.js';
import { grantRoleSchema, issueApiKeySchema } from '../services/book.service.js';
import { permissionNote, securityFor, securitySchemes, type SecurityRequirement } from './security.js';

/**
 * The OpenAPI document, built from the route registry.
 *
 * Nothing here is written twice. A path comes from `path`, a credential requirement from
 * `access`, the `Idempotency-Key` header from `acceptsIdempotencyKey` - the same function the
 * middleware uses to decide whether to apply the guard - and the schemas from the row itself,
 * which is the object its handler parses through. The one thing this file states on its own
 * authority is the `Problem` shape, which is kept next to `problem.ts`'s definition below so
 * that the two drifting apart is visible in a diff.
 *
 * The document is generated rather than committed by hand, and `docs/openapi.json` is the
 * committed output. `openapi.test.ts` fails when they disagree.
 */

const OPENAPI_VERSION = '3.1.0';

/**
 * The API's version, not the package's. It is `0.1.0` because nothing outside this repository
 * depends on it yet; the day something does, this is the number that has to start moving, and
 * a `/v1` prefix is the conversation that comes with it.
 */
const API_VERSION = '0.1.0';

export type JsonSchema = Record<string, unknown>;

export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly description?: string;
  readonly schema: JsonSchema;
}

export interface OpenApiResponse {
  readonly description: string;
  readonly content?: Readonly<Record<string, { readonly schema: JsonSchema }>>;
}

export interface OpenApiOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly security: readonly SecurityRequirement[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: {
    readonly required: boolean;
    readonly content: Readonly<Record<string, { readonly schema: JsonSchema }>>;
  };
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: { readonly title: string; readonly version: string; readonly description: string };
  readonly paths: Readonly<Record<string, Partial<Record<RouteMethod, OpenApiOperation>>>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchema>>;
    readonly securitySchemes: typeof securitySchemes;
  };
}

/**
 * The named components, and the two conversions they need.
 *
 * A schema is registered under an id so it becomes one `#/components/schemas/...` entry that
 * every operation refers to, instead of the same object inlined into nine responses.
 *
 * Two registries rather than one because `io` is not a property of a schema: `postEntryInput`
 * accepts an ISO string and produces a `Date`, so the JSON Schema for what a client sends and
 * the one for what the server holds are different documents. Requests convert as `input`,
 * responses as `output`, and a shared id would have to be one or the other.
 */
const requestComponents = z.registry<{ id: string }>();
const responseComponents = z.registry<{ id: string }>();

const componentIds = new Map<z.ZodType, string>();

type ComponentRegistry = ReturnType<typeof z.registry<{ id: string }>>;

function component(registry: ComponentRegistry, schema: z.ZodType, id: string): void {
  registry.add(schema, { id });
  componentIds.set(schema, id);
}

component(requestComponents, credentials, 'Credentials');
component(requestComponents, createBookInput, 'CreateBookInput');
component(requestComponents, createAccountInput, 'CreateAccountInput');
component(requestComponents, postEntryInput, 'PostEntryInput');
component(requestComponents, reverseEntryInput, 'ReverseEntryInput');
component(requestComponents, grantRoleSchema, 'GrantRoleInput');
component(requestComponents, issueApiKeySchema, 'IssueApiKeyInput');

component(responseComponents, bookResource, 'Book');
component(responseComponents, bookList, 'BookList');
component(responseComponents, accountResource, 'Account');
component(responseComponents, accountList, 'AccountList');
component(responseComponents, entryResource, 'Entry');
component(responseComponents, balanceResource, 'Balance');
component(responseComponents, trialBalanceResource, 'TrialBalance');
component(responseComponents, postingPageResource, 'PostingPage');
component(responseComponents, membershipResource, 'Membership');
component(responseComponents, issuedApiKeyResource, 'IssuedApiKey');
component(responseComponents, sessionResource, 'Session');

/**
 * `z.coerce.date()` has no JSON Schema of its own - a Date is not a JSON type - and Zod
 * throws rather than guess. What crosses the wire is the string the coercion accepts, so
 * that is what the document says, and `unrepresentable: 'any'` is what stops the throw
 * before this runs.
 */
const conversion = {
  target: 'draft-2020-12',
  unrepresentable: 'any',
  override: ({ zodSchema, jsonSchema }: { zodSchema: z.core.$ZodTypes; jsonSchema: JsonSchema }) => {
    if (zodSchema._zod.def.type === 'date') {
      Object.assign(jsonSchema, { type: 'string', format: 'date-time' });
    }
  },
} as const;

/**
 * RFC 9457, as `http/problem.ts` writes it.
 *
 * Hand-written, because `ProblemDocument` is an interface with an index signature for
 * extension members and there is no schema to convert. Read it against `problem()` next door:
 * `type` through `requestId` are unconditional, `errors` appears on validation failures, and
 * the extension members - `available` on an overdraft, for instance - are what
 * `additionalProperties` leaves room for.
 */
const problemSchema: JsonSchema = {
  type: 'object',
  description:
    'RFC 9457 Problem Details. `code` is the stable identifier a client should branch on; ' +
    '`requestId` is echoed in `X-Request-Id` and is what finds the failure in the logs.',
  properties: {
    type: { type: 'string', format: 'uri', description: 'An identifier, not a URL to fetch.' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string', description: 'The path that produced it.' },
    code: { type: 'string' },
    requestId: { type: 'string' },
    errors: {
      type: 'array',
      description: 'Field-level detail, on validation failures only.',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, message: { type: 'string' } },
        required: ['path', 'message'],
      },
    },
  },
  required: ['type', 'title', 'status', 'detail', 'instance', 'code', 'requestId'],
  additionalProperties: true,
};

export function buildOpenApiDocument(definitions: readonly RouteDefinition[]): OpenApiDocument {
  const paths: Record<string, Partial<Record<RouteMethod, OpenApiOperation>>> = {};

  for (const definition of definitions) {
    const path = toOpenApiPath(definition.path);
    paths[path] = { ...paths[path], [definition.method]: operationFor(definition) };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Ledger API',
      version: API_VERSION,
      description:
        'A double-entry ledger. Amounts are decimal strings, never JSON numbers; posting ids ' +
        'are strings because a bigserial outruns `Number.MAX_SAFE_INTEGER`; timestamps are ' +
        'ISO 8601 with an offset. Balances are derived from postings and are never stored.',
    },
    paths,
    components: {
      schemas: { ...componentSchemas(), Problem: problemSchema },
      securitySchemes,
    },
  };
}

/** Express ':bookId' is OpenAPI '{bookId}'. */
function toOpenApiPath(path: string): string {
  return path.replace(/:(\w+)/g, '{$1}');
}

function operationFor(definition: RouteDefinition): OpenApiOperation {
  const parameters = [...pathParameters(definition), ...queryParameters(definition), ...idempotencyParameter(definition)];
  const description = permissionNote(definition.access);
  const body = definition.request?.body;

  return {
    operationId: operationId(definition),
    summary: definition.summary,
    ...(description === null ? {} : { description }),
    security: securityFor(definition),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(body === undefined
      ? {}
      : { requestBody: { required: true, content: { 'application/json': { schema: schemaFor(body, 'input') } } } }),
    responses: responsesFor(definition),
  };
}

/**
 * `post /books/{bookId}/entries` becomes `postBooksBookIdEntries`.
 *
 * Derived rather than declared, for the same reason as everything else here: an operation id
 * written per row is a second name for a route, and the two would eventually disagree.
 */
function operationId(definition: RouteDefinition): string {
  const segments = toOpenApiPath(definition.path)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => segment.replaceAll(/[{}-]/g, ''));

  return definition.method + segments.map((segment) => segment[0]?.toUpperCase() + segment.slice(1)).join('');
}

function pathParameters(definition: RouteDefinition): readonly OpenApiParameter[] {
  const declared = definition.request?.params;
  if (declared === undefined) return [];

  return propertiesOf(declared, 'input').map(({ name, schema }) => ({
    name,
    in: 'path' as const,
    // A path parameter is always required - the route does not exist without it.
    required: true,
    schema,
  }));
}

function queryParameters(definition: RouteDefinition): readonly OpenApiParameter[] {
  const declared = definition.request?.query;
  if (declared === undefined) return [];

  const required = new Set(requiredOf(declared, 'input'));

  return propertiesOf(declared, 'input').map(({ name, schema }) => ({
    name,
    in: 'query' as const,
    required: required.has(name),
    schema,
  }));
}

function idempotencyParameter(definition: RouteDefinition): readonly OpenApiParameter[] {
  if (!acceptsIdempotencyKey(definition)) return [];

  return [
    {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description:
        'Optional. A retry presenting the same key returns the first response rather than ' +
        'repeating the write. Reusing a key for a different request is a 422; retrying while ' +
        'the first is still in flight is a 409.',
      schema: { type: 'string', minLength: 1 },
    },
  ];
}

function responsesFor(definition: RouteDefinition): Readonly<Record<string, OpenApiResponse>> {
  const responses: Record<string, OpenApiResponse> = {};
  const success = definition.response;

  if (success !== undefined) {
    responses[String(success.status)] = {
      description: definition.summary,
      ...(success.schema === undefined
        ? {}
        : { content: { 'application/json': { schema: schemaFor(success.schema, 'output') } } }),
    };

    for (const other of definition.alsoAnswers ?? []) {
      responses[String(other.status)] = {
        description: other.description,
        ...(success.schema === undefined
          ? {}
          : { content: { 'application/json': { schema: schemaFor(success.schema, 'output') } } }),
      };
    }
  }

  // Everything below is derived from `access` and from what the row declares it parses. None
  // of it is per-route prose, which is what keeps a route from quietly acquiring a documented
  // error the middleware never produces - or losing one it does.
  const problems: [number, string][] = [];

  if (definition.request !== undefined || definition.method === 'post') {
    problems.push([400, 'The request does not parse as the shape this route declares.']);
  }

  if (definition.access.kind !== 'public' || definition.credential !== undefined) {
    problems.push([401, 'No credential was presented, or the one presented did not verify.']);
  }

  if (definition.access.kind === 'book') {
    problems.push([403, 'A member of this book whose role does not carry the permission above.']);
    problems.push([
      404,
      'No such book, account or entry - or one the caller is not a member of. The two are ' +
        'deliberately the same answer: a 403 would confirm the resource exists to anyone ' +
        'holding an id.',
    ]);
  }

  if (acceptsIdempotencyKey(definition)) {
    problems.push([409, 'A request with this `Idempotency-Key` is still in flight.']);
  }

  if (definition.method === 'post') {
    problems.push([
      422,
      'Well-formed, and describes something that cannot be done: an unbalanced entry, a ' +
        'closed account, an overdrawn one, a currency that does not match.',
    ]);
  }

  for (const [status, description] of problems) {
    responses[String(status)] = {
      description,
      content: { [PROBLEM_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/Problem' } } },
    };
  }

  return responses;
}

/** A `$ref` for a named component, or the schema itself for the one-off shapes. */
function schemaFor(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const id = componentIds.get(schema);
  if (id !== undefined) return { $ref: `#/components/schemas/${id}` };

  return withoutJsonSchemaKeys(z.toJSONSchema(schema, { ...conversion, io }) as JsonSchema);
}

function propertiesOf(schema: z.ZodType, io: 'input' | 'output'): readonly { name: string; schema: JsonSchema }[] {
  const converted = z.toJSONSchema(schema, { ...conversion, io }) as {
    properties?: Record<string, JsonSchema>;
  };

  return Object.entries(converted.properties ?? {}).map(([name, property]) => ({ name, schema: property }));
}

function requiredOf(schema: z.ZodType, io: 'input' | 'output'): readonly string[] {
  const converted = z.toJSONSchema(schema, { ...conversion, io }) as { required?: string[] };
  return converted.required ?? [];
}

function componentSchemas(): Record<string, JsonSchema> {
  const uri = (id: string) => `#/components/schemas/${id}`;

  const requests = z.toJSONSchema(requestComponents, { ...conversion, io: 'input', uri }).schemas;
  const responses = z.toJSONSchema(responseComponents, { ...conversion, io: 'output', uri }).schemas;

  const schemas: Record<string, JsonSchema> = {};
  for (const [id, schema] of [...Object.entries(requests), ...Object.entries(responses)]) {
    schemas[id] = withoutJsonSchemaKeys(schema as JsonSchema);
  }

  return schemas;
}

/**
 * `$schema` and `$id` are correct in a standalone JSON Schema document and noise inside a
 * components section, where the key already is the identity.
 */
function withoutJsonSchemaKeys(schema: JsonSchema): JsonSchema {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}
