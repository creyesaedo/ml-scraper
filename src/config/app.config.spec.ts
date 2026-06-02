import appConfig from './app.config';

const CORE_SITES = ['MLA', 'MLB', 'MLC', 'MLM', 'MCO', 'MPE', 'MLU', 'MLV'];

/** Runs the registerAs factory with a clean copy of process.env. */
function load() {
  return appConfig();
}

describe('app.config', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    // Fresh env per test so leftover vars never bleed across cases.
    process.env = { ...ORIGINAL_ENV };
    delete process.env.APP_MODE;
    delete process.env.SNAPSHOT_CATEGORY_LIMIT;
    delete process.env.SCRAPER_RETRY_PARTIAL_RENDER;
    delete process.env.SCRAPER_MAX_CONCURRENT;
    delete process.env.SCRAPER_FAILURE_THRESHOLD;
    delete process.env.DECODO_RATE_LIMIT_PER_SEC;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('APP_MODE', () => {
    it('defaults to DEVELOPMENT with a single core site when unset', () => {
      const cfg = load();
      expect(cfg.appMode).toBe('DEVELOPMENT');
      expect(cfg.snapshotSiteIds).toHaveLength(1);
      expect(CORE_SITES).toContain(cfg.snapshotSiteIds[0]);
    });

    it('enables PRODUCTION with all 8 core sites for the exact value', () => {
      process.env.APP_MODE = 'PRODUCTION';
      const cfg = load();
      expect(cfg.appMode).toBe('PRODUCTION');
      expect(cfg.snapshotSiteIds).toEqual(CORE_SITES);
    });

    it('is case-insensitive for PRODUCTION', () => {
      process.env.APP_MODE = 'production';
      expect(load().appMode).toBe('PRODUCTION');
    });

    it('falls back to DEVELOPMENT for any unknown value', () => {
      process.env.APP_MODE = 'whatever';
      expect(load().appMode).toBe('DEVELOPMENT');
    });
  });

  describe('snapshotCategoryLimit', () => {
    it('is null when unset', () => {
      expect(load().snapshotCategoryLimit).toBeNull();
    });
    it('parses a positive integer', () => {
      process.env.SNAPSHOT_CATEGORY_LIMIT = '5';
      expect(load().snapshotCategoryLimit).toBe(5);
    });
    it('is null for non-numeric values', () => {
      process.env.SNAPSHOT_CATEGORY_LIMIT = 'abc';
      expect(load().snapshotCategoryLimit).toBeNull();
    });
    it('is null for zero or negative', () => {
      process.env.SNAPSHOT_CATEGORY_LIMIT = '0';
      expect(load().snapshotCategoryLimit).toBeNull();
    });
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
    it('uses default rate limit and concurrency', () => {
      const cfg = load();
      expect(cfg.decodoRateLimitPerSec).toBe(10);
      expect(cfg.scraperMaxConcurrent).toBe(10);
      expect(cfg.scraperFailureThreshold).toBe(10);
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
