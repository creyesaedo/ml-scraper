import { ConfigType } from '@nestjs/config';
import pLimit from 'p-limit';
import appConfig from '../../config/app.config';

export type ScraperSlot = pLimit.Limit;

/**
 * Process-wide scraper concurrency cap. MlScraperService wraps every outbound
 * request through this limiter, so total in-flight requests can never exceed
 * SCRAPER_MAX_CONCURRENT regardless of the outer p-limits in
 * ProductCollectionService (currently 3 categories × 8 products = up to 24).
 */
export const SCRAPER_SEMAPHORE = Symbol('SCRAPER_SEMAPHORE');

export const scraperSemaphoreProvider = {
  provide: SCRAPER_SEMAPHORE,
  useFactory: (config: ConfigType<typeof appConfig>): ScraperSlot =>
    pLimit(config.scraperMaxConcurrent),
  inject: [appConfig.KEY],
};
