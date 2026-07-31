import type { RequestHandler, Response } from 'express';

/**
 * One id per request, echoed in the response and carried into every log line.
 *
 * An inbound `X-Request-Id` is honoured so that a trace started by a proxy, a load balancer
 * or a calling service stays one trace rather than becoming two unrelated halves. It is
 * validated and truncated first: the value is attacker-controlled, it ends up in a response
 * header and in structured logs, and a header value containing a newline is how a log file
 * gets a forged entry written into it.
 *
 * The header goes out before anything else runs, so a request that fails in a later
 * middleware - or times out with no response body at all - still has an id the client saw.
 */

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Conservative on purpose: enough for a uuid or a trace id, and nothing exotic. */
const ACCEPTABLE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function requestIdMiddleware(newId: () => string): RequestHandler {
  return (request, response, next) => {
    const inbound = request.get(REQUEST_ID_HEADER);
    const requestId = inbound !== undefined && ACCEPTABLE.test(inbound) ? inbound : newId();

    response.locals.requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  };
}

/**
 * The id for this response.
 *
 * Falls back to a constant rather than throwing. This is called from the error middleware,
 * and an error middleware that can itself throw - because a request failed before the id was
 * assigned - turns a handled failure into an unhandled one.
 */
export function requestIdOf(response: Response): string {
  const { requestId } = response.locals as { requestId?: unknown };
  return typeof requestId === 'string' ? requestId : 'unknown';
}
