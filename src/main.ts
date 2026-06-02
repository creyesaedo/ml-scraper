import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * HTTP server entry point. Creates the NestJS app, enables graceful shutdown so
 * DB connections close cleanly on exit, allows read-only (GET) CORS requests
 * from the portfolio frontend (any origin when PORTFOLIO_URL is unset), and
 * starts listening on PORT (defaults to 8000).
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.enableCors({
    origin: process.env.PORTFOLIO_URL || '*',
    methods: ['GET'],
  });
  const port = process.env.PORT ?? 8000;
  await app.listen(port);
  console.log(`Application running on port ${port}`);
}

void bootstrap();
