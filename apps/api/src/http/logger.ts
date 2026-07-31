import { pino, type Logger } from 'pino';
import { pinoHttp, type HttpLogger } from 'pino-http';
import type { Config } from '../config.js';
import { REQUEST_ID_HEADER } from './request-id.js';

/**
 * Structured logging.
 *
 * One line per request, as JSON, with the request id on every line - which is the property
 * that makes the id worth echoing to clients at all. Stage 6 puts that id in the error
 * toast, so a user reporting "it failed" hands over the one string that finds their request.
 *
 * The redaction list is not decoration. `authorization` carries a bearer token, `cookie`
 * carries a refresh token, and both are credentials that would otherwise be written to disk
 * in plaintext on every single request - which is how a log file becomes the softest target
 * in a system that got everything else right.
 */

const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Bodies are not logged, but a future `req.body` on an error path would otherwise take
  // these with it. Cheaper to list them now than to notice afterwards.
  'req.body.password',
  'req.body.token',
  'req.body.refreshToken',
];

export function createLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACTED, censor: '[redacted]' },
    base: { env: config.nodeEnv },
  });
}

export function httpLogger(logger: Logger): HttpLogger {
  return pinoHttp({
    logger,

    // Read back off the header rather than out of `res.locals`, because pino-http types this
    // as a bare Node ServerResponse. Same string either way - the request-id middleware sets
    // both, and it runs first - and this way the log line and the header the client holds
    // cannot drift apart, because there is only one source for them.
    genReqId: (_request, response) => {
      const header = response.getHeader(REQUEST_ID_HEADER);
      return typeof header === 'string' ? header : 'unknown';
    },

    // A 4xx is the client being told no, which is information, not a fault. Logging it at
    // error level trains everyone to ignore errors.
    customLogLevel: (_request, response, error) => {
      if (error !== undefined || response.statusCode >= 500) return 'error';
      if (response.statusCode >= 400) return 'warn';
      return 'info';
    },

    customProps: (request) => {
      // The route pattern rather than the concrete path, so log volume can be grouped by
      // endpoint instead of by book id. Express attaches `route` once a handler has matched;
      // pino-http types the request as a bare IncomingMessage, which does not know that.
      const { route } = request as unknown as { route?: { path?: unknown } };
      return { route: typeof route?.path === 'string' ? route.path : undefined };
    },
  });
}
