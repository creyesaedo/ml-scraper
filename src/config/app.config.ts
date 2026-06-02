import { registerAs } from '@nestjs/config';

export type AppMode = 'DEVELOPMENT' | 'PRODUCTION';

export interface AppConfig {
  appMode: AppMode;
  databaseUrl: string;
  mlClientId: string;
  mlClientSecret: string;
  mlBaseUrl: string;
  decodoApiToken: string;
  decodoRateLimitPerSec: number;
  scraperMaxConcurrent: number;
  scraperFailureThreshold: number;
  scraperFailureDumpDir: string;
  scraperRetryPartialRender: boolean;
  snapshotSiteIds: string[];
  snapshotCategoryLimit: number | null;
  snapshotCategoriesBySite: Record<string, string[]>;
  syncDayOfWeek: string;
  syncHour: number;
}

const PROD_CORE_SITES = ['MLA', 'MLB', 'MLC', 'MLM', 'MCO', 'MPE', 'MLU', 'MLV'];

/**
 * Reads APP_MODE. Only the exact value "PRODUCTION" turns production on;
 * anything else (blank, typo, unknown) falls back to DEVELOPMENT so a mistake
 * can never trigger the expensive full production scrape by accident.
 */
function parseAppMode(raw: string | undefined): AppMode {
  return raw?.toUpperCase() === 'PRODUCTION' ? 'PRODUCTION' : 'DEVELOPMENT';
}

/** Picks one of the core sites at random, used as the DEVELOPMENT-mode target. */
function pickRandomDevelopmentSite(): string {
  return PROD_CORE_SITES[Math.floor(Math.random() * PROD_CORE_SITES.length)];
}

/**
 * Parses SNAPSHOT_CATEGORY_LIMIT into a positive integer, or null when unset or
 * invalid (null means "no limit").
 */
function parseCategoryLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export default registerAs(
  'app',
  (): AppConfig => {
    const appMode = parseAppMode(process.env.APP_MODE);

    // APP_MODE is the single source of truth for which sites/categories to scrape.
    // DEVELOPMENT intentionally ignores SNAPSHOT_SITE_IDS / SNAPSHOT_CATEGORIES_* to
    // prevent accidental production spend when the env vars are mis-set.
    // In DEVELOPMENT we pick a random site from the 8 core. The specific parent
    // category is picked at runtime from the DB by the CLI (see run-sync.ts),
    // since it needs a live query against the categories table.
    const snapshotSiteIds =
      appMode === 'PRODUCTION' ? PROD_CORE_SITES : [pickRandomDevelopmentSite()];

    // Empty in both modes — PRODUCTION wants all parent categories, DEVELOPMENT
    // gets its random pick injected by the CLI before collect() runs.
    const snapshotCategoriesBySite: Record<string, string[]> = {};

    return {
      appMode,
      databaseUrl:
        process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/market_analysis',
      mlClientId: process.env.ML_CLIENT_ID ?? '',
      mlClientSecret: process.env.ML_CLIENT_SECRET ?? '',
      mlBaseUrl: process.env.ML_BASE_URL ?? 'https://api.mercadolibre.com',
      decodoApiToken: process.env.DECODO_API_TOKEN ?? '',
      decodoRateLimitPerSec: parseInt(process.env.DECODO_RATE_LIMIT_PER_SEC ?? '10', 10),
      scraperMaxConcurrent: Math.max(1, parseInt(process.env.SCRAPER_MAX_CONCURRENT ?? '10', 10)),
      scraperFailureThreshold: Math.max(1, parseInt(process.env.SCRAPER_FAILURE_THRESHOLD ?? '10', 10)),
      scraperFailureDumpDir: process.env.SCRAPER_FAILURE_DUMP_DIR ?? 'tmp/scraper-failures',
      // Retry a page once when Decodo returns a partial render (200 but body
      // too small). Defaults to enabled; set to "false" to opt out and save the
      // extra billed request at the cost of more null-enrichment rows.
      scraperRetryPartialRender: process.env.SCRAPER_RETRY_PARTIAL_RENDER !== 'false',
      snapshotSiteIds,
      snapshotCategoryLimit: parseCategoryLimit(process.env.SNAPSHOT_CATEGORY_LIMIT),
      snapshotCategoriesBySite,
      syncDayOfWeek: process.env.SYNC_DAY_OF_WEEK ?? 'mon',
      syncHour: parseInt(process.env.SYNC_HOUR ?? '3', 10),
    };
  },
);
