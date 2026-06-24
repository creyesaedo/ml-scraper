import { ConfigType } from '@nestjs/config';
import appConfig from '../../config/app.config';
import { AcquireToken, AdaptiveLimiter, RequestOutcome } from './adaptive-limiter';

/**
 * Process-wide scraper concurrency gate. MlScraperService routes every outbound
 * request through this limiter, so total in-flight requests can never exceed the
 * current window regardless of the outer p-limits in CategoryFetchService.
 *
 * The gate exposes a minimal acquire/feedback contract so the implementation can
 * be either:
 *   - {@link AdaptiveLimiter} (default) — AIMD window that self-tunes to the
 *     backend's real, variable latency, and
 *   - a fixed window (SCRAPER_ADAPTIVE_CONCURRENCY=false) — a constant pool that
 *     ignores feedback, preserving the old `p-limit(scraperMaxConcurrent)`
 *     behaviour for operators who want a hard, predictable cap.
 */
export const SCRAPER_SEMAPHORE = Symbol('SCRAPER_SEMAPHORE');

export interface ScraperGate {
  acquire(): Promise<AcquireToken>;
  feedback(outcome: RequestOutcome, saturatedAtAcquire: boolean): void;
  getStats(): { limit: number; inFlight: number; queued: number };
}

export const scraperSemaphoreProvider = {
  provide: SCRAPER_SEMAPHORE,
  useFactory: (config: ConfigType<typeof appConfig>): ScraperGate =>
    config.scraperAdaptiveConcurrency
      ? new AdaptiveLimiter({
          minLimit: config.scraperMinConcurrent,
          maxLimit: config.scraperMaxConcurrent,
          initialLimit: config.scraperInitialConcurrent,
          increaseStep: config.scraperConcurrencyIncreaseStep,
          decreaseFactor: config.scraperConcurrencyDecreaseFactor,
        })
      : // Fixed window: start = ceiling, no increase, no decrease (feedback is a
        // no-op). Identical steady-state behaviour to the previous fixed pool.
        new AdaptiveLimiter({
          minLimit: config.scraperMaxConcurrent,
          maxLimit: config.scraperMaxConcurrent,
          initialLimit: config.scraperMaxConcurrent,
          increaseStep: 0,
          decreaseFactor: 1,
        }),
  inject: [appConfig.KEY],
};
