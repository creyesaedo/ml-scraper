import { registerAs } from '@nestjs/config';

export interface AppConfig {
  databaseUrl: string;
  mlClientId: string;
  mlClientSecret: string;
  mlBaseUrl: string;
  decodoApiToken: string;
  decodoRateLimitPerSec: number;
  scraperMaxConcurrent: number;
  scraperFailureThreshold: number;
  scraperFailureDumpDir: string;
  snapshotSiteIds: string[];
  snapshotCategoryLimit: number | null;
  snapshotCategoriesBySite: Record<string, string[]>;
  syncDayOfWeek: string;
  syncHour: number;
}

function parseSiteIds(raw: string | undefined): string[] {
  if (!raw) return ['MLA'];
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

function parseCategoryLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Reads all SNAPSHOT_CATEGORIES_<SITE> env vars into a per-site whitelist map.
// Example: SNAPSHOT_CATEGORIES_MLC=MLC1574,MLC1648 → { MLC: ['MLC1574', 'MLC1648'] }
function parseCategoriesBySite(): Record<string, string[]> {
  const prefix = 'SNAPSHOT_CATEGORIES_';
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix) || !value) continue;
    const site = key.slice(prefix.length).toUpperCase();
    const ids = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (ids.length) result[site] = ids;
  }
  return result;
}

export default registerAs(
  'app',
  (): AppConfig => ({
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
    snapshotSiteIds: parseSiteIds(process.env.SNAPSHOT_SITE_IDS),
    snapshotCategoryLimit: parseCategoryLimit(process.env.SNAPSHOT_CATEGORY_LIMIT),
    snapshotCategoriesBySite: parseCategoriesBySite(),
    syncDayOfWeek: process.env.SYNC_DAY_OF_WEEK ?? 'mon',
    syncHour: parseInt(process.env.SYNC_HOUR ?? '3', 10),
  }),
);
