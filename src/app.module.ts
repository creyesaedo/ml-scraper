import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config/app.config';
import { PrismaModule } from './prisma/prisma.module';
import { CategoriesModule } from './categories/categories.module';
import { ProductsModule } from './products/products.module';
import { SyncModule } from './sync/sync.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AppController } from './app.controller';

// The internal NestJS cron (WeeklySyncJob) is opt-in. GitHub Actions and the
// CLI keep it off to avoid double-scheduling against the external trigger.
const internalSchedulerEnabled =
  process.env.ENABLE_INTERNAL_SCHEDULER?.toLowerCase() === 'true';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: '.env',
    }),
    PrismaModule,
    CategoriesModule,
    ProductsModule,
    SyncModule,
    ...(internalSchedulerEnabled ? [SchedulerModule] : []),
  ],
  controllers: [AppController],
})
export class AppModule {}
