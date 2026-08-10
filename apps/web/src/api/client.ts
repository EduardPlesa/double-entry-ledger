import { toApiError } from './problem';
import { getAccessToken, refreshSession } from './session';

/**
 * The only place in the application that talks to the API.
 *
 * One function rather than a hook, so it can be called from a query, a mutation, a loader or a
 * test with no React involved. It owns three things that must not be reimplemented per call
 * site:
 *
 *   the credential   the bearer token, read at call time rather than captured, so a refresh
 *                    that lands mid-flight is picked up by the retry rather than by the next
 *                    component render.
 *   the retry        one refresh, one replay, and never again. A second 401 after a successful
 *                    refresh is a real answer - the caller may not do that thing - and
 *                    retrying it would be a loop.
 *   the key          `Idempotency-Key` passes through unchanged on the replay. A retry that
 *                    mints a new key is not a retry, it is a second request, which is the
 *                    exact failure the header exists to prevent.
 *
 * A 401 from a path under `/auth/` is exempt from the retry. `/auth/login` answering 401 is not
 * an expired access token - there is no access token in play yet - it is an answer about the
 * credential the caller just submitted. Refreshing there would rotate the refresh token on
 * every mistyped password and, with a dead refresh cookie, would sign a genuinely signed-in
 * user out for typing their password wrong once.
 */

export interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  /** Book-scoped POSTs only; the API rejects the header where it cannot honour it. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);

  if (response.status === 401 && !path.startsWith('/auth/')) {
    const session = await refreshSession();
    if (session === null) throw await toApiError(response);

    const replay = await send(path, options);
    if (!replay.ok) throw await toApiError(replay);
    return readBody<T>(replay);
  }

  if (!response.ok) throw await toApiError(response);
  return readBody<T>(response);
}

function send(path: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ accept: 'application/json' });

  const token = getAccessToken();
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.idempotencyKey !== undefined) {
    headers.set('idempotency-key', options.idempotencyKey);
  }

  return fetch(path, {
    method,
    headers,
    credentials: 'include',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function readBody<T>(response: Response): Promise<T> {
  // 204 on logout, and nothing else in this API answers with an empty body. `json()` on one
  // throws, which would turn a successful call into a failure.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
