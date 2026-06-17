import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config/app.config';
import { WorkerModule } from './worker/worker.module';
import { AppController } from './app.controller';

/**
 * ml-scraper is a stateless scraping worker: it performs all fetching (Decodo +
 * ML API + FX + holidays) and exposes it over HTTP via WorkerModule. It owns no
 * database — persistence and orchestration live in the separate ml-service.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: '.env',
    }),
    WorkerModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
