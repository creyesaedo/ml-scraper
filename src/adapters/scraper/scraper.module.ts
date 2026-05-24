import { Module } from '@nestjs/common';
import { MlScraperService } from './ml-scraper.service';
import { ScraperHealthService } from './scraper-health.service';
import { scraperSemaphoreProvider } from './scraper-semaphore.provider';

@Module({
  providers: [MlScraperService, ScraperHealthService, scraperSemaphoreProvider],
  exports: [MlScraperService, ScraperHealthService],
})
export class ScraperModule {}
