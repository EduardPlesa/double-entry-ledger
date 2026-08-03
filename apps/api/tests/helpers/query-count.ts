import type { Pool, PoolClient } from 'pg';

/**
 * Counts the statements a block of work actually sends.
 *
 * At the driver, not at the ORM. `BEGIN`, `set_config` and `COMMIT` are statements the process
 * sent and round trips it paid for, and the number an N+1 assertion is about is round trips.
 * Counting what drizzle chose to report through its `logger` option would miss a raw
 * `pool.query`, which is precisely the shape an extra round trip takes when one gets added.
 *
 * `pool.query` acquires a client and calls `client.query` on it, so patching clients catches
 * pooled and transactional statements alike with one hook.
 *
 * **Instrument the pool before anything queries it.** The `connect` event only fires for
 * connections opened after the listener is attached; a client already idle in the pool would
 * go unpatched and its statements would be invisible. Callers create their own pool and
 * instrument it in the same breath.
 */

export interface Measurement<T> {
  readonly result: T;
  /** In the order they were sent, whitespace collapsed, truncated for readability. */
  readonly statements: readonly string[];
}

export interface QueryRecorder {
  measure<T>(fn: () => Promise<T>): Promise<Measurement<T>>;
}

/** Marks a client as already wrapped, so a reconnect cannot stack two wrappers on one client. */
const PATCHED = Symbol('ledger.queryCountPatched');

interface PatchableClient {
  query: (...args: unknown[]) => unknown;
  [PATCHED]?: true;
}

export function instrumentPool(pool: Pool): QueryRecorder {
  let recording: string[] | null = null;

  const patch = (client: PoolClient): void => {
    const patchable = client as unknown as PatchableClient;
    if (patchable[PATCHED] === true) return;
    patchable[PATCHED] = true;

    const original = patchable.query.bind(patchable);
    patchable.query = (...args: unknown[]): unknown => {
      recording?.push(statementText(args[0]));
      return original(...args);
    };
  };

  pool.on('connect', patch);

  return {
    async measure<T>(fn: () => Promise<T>): Promise<Measurement<T>> {
      if (recording !== null) {
        throw new Error('measure() is already recording: nested measurements are not supported');
      }

      const statements: string[] = [];
      recording = statements;

      try {
        return { result: await fn(), statements };
      } finally {
        recording = null;
      }
    },
  };
}

/** The first argument to `client.query` is either the SQL or a config object carrying it. */
function statementText(first: unknown): string {
  const raw = typeof first === 'string' ? first : textOf(first);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function textOf(candidate: unknown): string {
  if (typeof candidate === 'object' && candidate !== null && 'text' in candidate) {
    const { text } = candidate as { text: unknown };
    if (typeof text === 'string') return text;
  }
  return '<unrecognised statement>';
}
