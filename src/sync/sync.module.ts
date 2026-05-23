import { Module } from '@nestjs/common';
import { HolidaysModule } from '../adapters/holidays/holidays.module';
import { MercadoLibreModule } from '../adapters/mercadolibre/mercadolibre.module';
import { ScraperModule } from '../adapters/scraper/scraper.module';
import { CategorySyncService } from './category-sync.service';
import { ProductCollectionService } from './product-collection.service';
import { SyncController } from './sync.controller';
import { SyncRunnerService } from './sync-runner.service';

@Module({
  imports: [MercadoLibreModule, ScraperModule, HolidaysModule],
  controllers: [SyncController],
  providers: [SyncRunnerService, CategorySyncService, ProductCollectionService],
  exports: [SyncRunnerService],
})
export class SyncModule {}
