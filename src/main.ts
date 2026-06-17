import { Logger } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

const logger = new Logger('Bootstrap');

/**
 * Last-resort process-level guards. Nest handles errors inside the request
 * lifecycle, but a rejected promise or thrown error escaping that lifecycle
 * (e.g. a background timer, a driver event) would otherwise crash the process
 * silently. We log it with full context; an uncaughtException leaves the
 * process in an undefined state, so we exit so the orchestrator can restart it.
 */
function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason instanceof Error ? reason.stack : reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — shutting down', err.stack ?? err.message);
    process.exit(1);
  });
}

/**
 * HTTP server entry point for the scraper worker. Creates the NestJS app,
 * enables graceful shutdown, and starts listening on PORT (defaults to 8001).
 * The worker is an internal service called server-to-server by ml-service, so
 * CORS allows the GET/POST verbs it serves.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // Catch-all filter: standardizes error responses and logs failures with
  // context while passing structured scraper-abort payloads through to ml-service.
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
  app.enableCors({
    origin: process.env.PORTFOLIO_URL || '*',
    methods: ['GET', 'POST'],
  });
  const port = process.env.PORT ?? 8001;
  await app.listen(port);
  logger.log(`Scraper worker running on port ${port}`);
}

installProcessGuards();

bootstrap().catch((err: unknown) => {
  // A failure here means the app never came up (bad config, DB unreachable,
  // port in use). Log it and exit non-zero so the container/host restarts us
  // instead of lingering in a half-started state.
  logger.error(
    'Failed to bootstrap application',
    err instanceof Error ? err.stack : String(err),
  );
  process.exit(1);
});
