import { Module } from '@nestjs/common';
import { MlScraperService } from './ml-scraper.service';

@Module({
  providers: [MlScraperService],
  exports: [MlScraperService],
})
export class ScraperModule {}
