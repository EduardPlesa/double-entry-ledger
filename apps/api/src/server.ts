import { pathToFileURL } from 'node:url';
import { ConfigError } from './config.js';
import { createApplication } from './composition.js';

/**
 * The process entrypoint.
 *
 * Every other module in this package builds pieces of the application and hands them back;
 * nothing calls `listen()`. That is deliberate - `createApplication` returns an `Express`
 * instance that supertest can drive directly, with no socket and no process lifecycle to
 * manage, which is the entire reason the test suite never needed this file. This is the one
 * place that turns the assembled application into a server a browser or curl can reach.
 *
 * What this deliberately does not do, so the gap reads as a choice rather than an oversight:
 *   - no clustering. One process, one event loop, like everywhere else in this codebase;
 *     add a worker pool if profiling ever asks for one, not before.
 *   - no TLS termination. That is a reverse proxy's job in front of this process, not this
 *     process's job behind it.
 *   - no readiness/liveness endpoint. Nothing here orchestrates restarts, so there is nothing
 *     yet that needs to ask this process whether it is ready.
 */

function startServer(): void {
  const application = createApplication();
  const { app, config, logger } = application;

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, `listening on port ${config.port}`);
  });

  /**
   * SIGTERM is how an orchestrator asks a process to stop; SIGINT is Ctrl-C at a terminal.
   * Both get the same answer: stop accepting new connections, let the ones already in flight
   * finish, then release the pool before the process exits. `server.close()` alone stops
   * accepting new connections but says nothing about the database - `application.close()` is
   * what actually ends the sockets Postgres is holding open on the other side, and skipping
   * it is the difference between a clean exit and a process that either lingers or leaves
   * Postgres to notice the pool went away on its own.
   */
  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');

    server.close((serverError) => {
      if (serverError) {
        logger.error({ error: serverError }, 'error while closing the HTTP server');
      }

      application
        .close()
        .catch((poolError: unknown) => {
          logger.error({ error: poolError }, 'error while closing the connection pool');
        })
        .finally(() => {
          process.exit(serverError ? 1 : 0);
        });
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    startServer();
  } catch (error) {
    // getConfig() - called inside createApplication() - throws ConfigError when the
    // environment is missing or invalid. That message already names what is wrong; a stack
    // trace on top of it would only bury the one line an operator needs to read. Anything
    // else is a bug this process did not anticipate, and a bug is exactly what should keep
    // its trace, so only this one case is special-cased.
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }

    throw error;
  }
}
