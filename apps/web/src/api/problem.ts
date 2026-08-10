/**
 * A failed response, as something a component can branch on.
 *
 * The API answers every failure as RFC 9457 `application/problem+json`, with two extensions
 * beyond the RFC: `code`, the domain error code, and `requestId`, the id echoed in
 * `X-Request-Id`. `code` is what a `switch` matches on; `requestId` is what goes in the toast,
 * so a user can read out the one string that finds their failure in the logs.
 *
 * The request id is read from the body first and the header second. The body is where the API
 * puts it deliberately, and reading it there means this works unchanged if the app is ever
 * served cross-origin, where the header would need `Access-Control-Expose-Headers` to be
 * readable at all.
 *
 * Nothing here throws. A 502 from a proxy that has never heard of this API is not a problem
 * document, and an error parser that fails on the ugliest failures is the one that leaves a
 * user with a blank screen.
 */

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly requestId: string | null;
  readonly errors: readonly FieldError[];
  /** Error-specific members - `accountId` and `shortfall` on an overdraft, for instance. */
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(input: {
    status: number;
    code: string;
    detail: string;
    requestId: string | null;
    errors: readonly FieldError[];
    extensions: Readonly<Record<string, unknown>>;
  }) {
    super(input.detail);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
    this.requestId = input.requestId;
    this.errors = input.errors;
    this.extensions = input.extensions;
  }
}

export async function toApiError(response: Response): Promise<ApiError> {
  const document = await readJson(response);
  const headerId = response.headers.get('x-request-id');

  if (document === null) {
    return new ApiError({
      status: response.status,
      code: 'UNKNOWN',
      detail: `the server answered ${String(response.status)} with no problem document`,
      requestId: headerId,
      errors: [],
      extensions: {},
    });
  }

  const { code, detail, requestId, errors, ...extensions } = document;

  return new ApiError({
    status: response.status,
    code: typeof code === 'string' ? code : 'UNKNOWN',
    detail: typeof detail === 'string' ? detail : `the server answered ${String(response.status)}`,
    requestId: typeof requestId === 'string' ? requestId : headerId,
    errors: fieldErrorsOf(errors),
    extensions,
  });
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fieldErrorsOf(value: unknown): readonly FieldError[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { path, message } = entry as { path?: unknown; message?: unknown };
    if (typeof path !== 'string' || typeof message !== 'string') return [];
    return [{ path, message }];
  });
}
