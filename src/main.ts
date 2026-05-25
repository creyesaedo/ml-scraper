import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

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

bootstrap();
