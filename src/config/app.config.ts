import { registerAs } from '@nestjs/config';

export interface AppConfig {
  databaseUrl: string;
  mlClientId: string;
  mlClientSecret: string;
  mlBaseUrl: string;
  brightdataScrapingBrowserWs: string;
  syncSiteId: string;
  syncDayOfWeek: string;
  syncHour: number;
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
    brightdataScrapingBrowserWs: process.env.BRIGHTDATA_SCRAPING_BROWSER_WS ?? '',
    syncSiteId: process.env.SYNC_SITE_ID ?? 'MLA',
    syncDayOfWeek: process.env.SYNC_DAY_OF_WEEK ?? 'mon',
    syncHour: parseInt(process.env.SYNC_HOUR ?? '3', 10),
  }),
);
