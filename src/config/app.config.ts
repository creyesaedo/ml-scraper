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
  decodoTransientMaxRetries: number;
  decodoRetryBackoffBaseMs: number;
  scraperMaxConcurrent: number;
  scraperFailureThreshold: number;
  scraperFailureDumpDir: string;
  scraperRetryPartialRender: boolean;
  skipKnownEmptyCategories: boolean;
  probeBestSellersOnCategorySync: boolean;
  snapshotSiteIds: string[];
  snapshotCategoryLimit: number | null;
  snapshotCategoriesBySite: Record<string, string[]>;
  syncDayOfWeek: string;
  syncHour: number;
}

// Venezuela (MLV) and Dominican Republic (MLD) run a reduced/classifieds-only
// MercadoLibre with no best-sellers section, so they are excluded — product
// scraping there yields 0 rows (see SITES_WITHOUT_BESTSELLERS in ml-parsers.ts).
const PROD_CORE_SITES = ['MLA', 'MLB', 'MLC', 'MLM', 'MCO', 'MPE', 'MLU'];

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
    // In DEVELOPMENT we pick a random site from the 7 core. The specific parent
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
      // How many times to retry a transient Decodo-side soft failure — HTTP 400
      // "Something went wrong. Please try again later" bursts. These are NOT
      // billed (status: "failed"), so retrying is free; default 10 to ride out
      // the multi-second bursts seen in the field (notably MCO). 5xx gateway
      // errors are capped at a single retry separately so the circuit breaker
      // still trips promptly on a real outage.
      decodoTransientMaxRetries: Math.max(
        0,
        parseInt(process.env.DECODO_TRANSIENT_MAX_RETRIES ?? '10', 10),
      ),
      // Base delay for the exponential backoff between transient-failure retries:
      // baseMs, 2×, 4×, … (capped in the scraper). Default 3 s.
      decodoRetryBackoffBaseMs: Math.max(
        0,
        parseInt(process.env.DECODO_RETRY_BACKOFF_BASE_MS ?? '3000', 10),
      ),
      scraperMaxConcurrent: Math.max(1, parseInt(process.env.SCRAPER_MAX_CONCURRENT ?? '10', 10)),
      scraperFailureThreshold: Math.max(1, parseInt(process.env.SCRAPER_FAILURE_THRESHOLD ?? '10', 10)),
      scraperFailureDumpDir: process.env.SCRAPER_FAILURE_DUMP_DIR ?? 'tmp/scraper-failures',
      // Retry a page once when Decodo returns a partial render (200 but body
      // too small). Defaults to enabled; set to "false" to opt out and save the
      // extra billed request at the cost of more null-enrichment rows.
      scraperRetryPartialRender: process.env.SCRAPER_RETRY_PARTIAL_RENDER !== 'false',
      // Product collection skips categories flagged has_bestsellers=false (no
      // usable /mas-vendidos page), saving one wasted Decodo request each.
      skipKnownEmptyCategories: process.env.SKIP_KNOWN_EMPTY_CATEGORIES !== 'false',
      // Category sync probes each in-scope (snapshotSiteIds) parent category once
      // and records has_bestsellers. Set to "false" to keep category sync free
      // (ML API only) and rely on whatever flags already exist in the DB.
      probeBestSellersOnCategorySync: process.env.PROBE_BESTSELLERS_ON_CATEGORY_SYNC !== 'false',
      snapshotSiteIds,
      snapshotCategoryLimit: parseCategoryLimit(process.env.SNAPSHOT_CATEGORY_LIMIT),
      snapshotCategoriesBySite,
      syncDayOfWeek: process.env.SYNC_DAY_OF_WEEK ?? 'mon',
      syncHour: parseInt(process.env.SYNC_HOUR ?? '3', 10),
    };
  },
);
