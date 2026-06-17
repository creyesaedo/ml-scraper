import { Module } from '@nestjs/common';
import { ExchangeModule } from '../adapters/exchange/exchange.module';
import { HolidaysModule } from '../adapters/holidays/holidays.module';
import { MercadoLibreModule } from '../adapters/mercadolibre/mercadolibre.module';
import { ScraperModule } from '../adapters/scraper/scraper.module';
import { CategoryFetchService } from './category-fetch.service';
import { ScraperController } from './scraper.controller';

/**
 * The scraper worker: fetches and enriches MercadoLibre data over HTTP and owns
 * no database. ml-service calls its endpoints to drive scraping.
 */
@Module({
  imports: [ScraperModule, MercadoLibreModule, ExchangeModule, HolidaysModule],
  controllers: [ScraperController],
  providers: [CategoryFetchService],
})
export class WorkerModule {}
