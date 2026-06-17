import appConfig from './app.config';

/** Runs the registerAs factory with a clean copy of process.env. */
function load() {
  return appConfig();
}

describe('app.config (worker)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Fresh env per test so leftover vars never bleed across cases.
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SCRAPER_RETRY_PARTIAL_RENDER;
    delete process.env.SCRAPER_MAX_CONCURRENT;
    delete process.env.SCRAPER_FAILURE_THRESHOLD;
    delete process.env.DECODO_RATE_LIMIT_PER_SEC;
    delete process.env.PRODUCT_CONCURRENCY;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('scraperRetryPartialRender', () => {
    it('defaults to true', () => {
      expect(load().scraperRetryPartialRender).toBe(true);
    });
    it('is false only when explicitly set to "false"', () => {
      process.env.SCRAPER_RETRY_PARTIAL_RENDER = 'false';
      expect(load().scraperRetryPartialRender).toBe(false);
    });
    it('stays true for any other value', () => {
      process.env.SCRAPER_RETRY_PARTIAL_RENDER = 'no';
      expect(load().scraperRetryPartialRender).toBe(true);
    });
  });

  describe('numeric defaults and guards', () => {
    it('uses default rate limit and auto-sizes the concurrency pool from it', () => {
      const cfg = load();
      expect(cfg.decodoRateLimitPerSec).toBe(10);
      // Auto pool = rate × DECODO_AVG_REQUEST_SECONDS (default 15) = 150.
      expect(cfg.scraperMaxConcurrent).toBe(150);
      // Products flow freely into the pool.
      expect(cfg.productConcurrency).toBe(150);
      expect(cfg.scraperFailureThreshold).toBe(10);
    });
    it('auto-sizes the pool to saturate a higher rate limit (Littles law)', () => {
      process.env.DECODO_RATE_LIMIT_PER_SEC = '25';
      const cfg = load();
      expect(cfg.scraperMaxConcurrent).toBe(375); // 25 × 15
      expect(cfg.productConcurrency).toBe(375);
    });
    it('honors an explicit SCRAPER_MAX_CONCURRENT override', () => {
      process.env.DECODO_RATE_LIMIT_PER_SEC = '25';
      process.env.SCRAPER_MAX_CONCURRENT = '40';
      const cfg = load();
      expect(cfg.scraperMaxConcurrent).toBe(40);
      expect(cfg.productConcurrency).toBe(40);
    });
    it('clamps scraperMaxConcurrent to a minimum of 1', () => {
      process.env.SCRAPER_MAX_CONCURRENT = '0';
      expect(load().scraperMaxConcurrent).toBe(1);
    });
    it('clamps scraperFailureThreshold to a minimum of 1', () => {
      process.env.SCRAPER_FAILURE_THRESHOLD = '-3';
      expect(load().scraperFailureThreshold).toBe(1);
    });
  });
});
