import { registerAs } from '@nestjs/config';

export type AppMode = 'DEVELOPMENT' | 'PRODUCTION';

export interface AppConfig {
  appMode: AppMode;
  databaseUrl: string;
  mlClientId: string;
  mlClientSecret: string;
  mlBaseUrl: string;
  brightdataApiToken: string;
  brightdataZone: string;
  scraperRateLimitPerSec: number;
  scraperMaxConcurrent: number;
  scraperFailureThreshold: number;
  scraperFailureDumpDir: string;
  snapshotSiteIds: string[];
  snapshotCategoryLimit: number | null;
  snapshotCategoriesBySite: Record<string, string[]>;
  syncDayOfWeek: string;
  syncHour: number;
}

const PROD_CORE_SITES = ['MLA', 'MLB', 'MLC', 'MLM', 'MCO', 'MPE', 'MLU', 'MLV'];

function parseAppMode(raw: string | undefined): AppMode {
  return raw?.toUpperCase() === 'PRODUCTION' ? 'PRODUCTION' : 'DEVELOPMENT';
}

function pickRandomDevelopmentSite(): string {
  return PROD_CORE_SITES[Math.floor(Math.random() * PROD_CORE_SITES.length)];
}

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
      brightdataApiToken: process.env.BRIGHTDATA_API_TOKEN ?? '',
      brightdataZone: process.env.BRIGHTDATA_ZONE ?? 'market_analysis',
      scraperRateLimitPerSec: parseInt(process.env.SCRAPER_RATE_LIMIT_PER_SEC ?? '10', 10),
      scraperMaxConcurrent: Math.max(1, parseInt(process.env.SCRAPER_MAX_CONCURRENT ?? '10', 10)),
      scraperFailureThreshold: Math.max(1, parseInt(process.env.SCRAPER_FAILURE_THRESHOLD ?? '10', 10)),
      scraperFailureDumpDir: process.env.SCRAPER_FAILURE_DUMP_DIR ?? 'tmp/scraper-failures',
      snapshotSiteIds,
      snapshotCategoryLimit: parseCategoryLimit(process.env.SNAPSHOT_CATEGORY_LIMIT),
      snapshotCategoriesBySite,
      syncDayOfWeek: process.env.SYNC_DAY_OF_WEEK ?? 'mon',
      syncHour: parseInt(process.env.SYNC_HOUR ?? '3', 10),
    };
  },
);
