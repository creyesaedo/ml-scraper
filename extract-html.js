/* One-off: extract a product's raw HTML THROUGH the worker's own scraping
 * pipeline (Decodo config, rate limiter, circuit breaker, geo override,
 * partial-render retry) by booting its Nest context and invoking MlScraperService. */
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { MlScraperService } = require('./dist/adapters/scraper/ml-scraper.service');

const URL = process.argv[2] || 'https://www.mercadolibre.cl/smart-tv-sharp-32-hd-2t-c32hf2265l/p/MLC65665429';
const SITE = process.argv[3] || 'MLC';
const OUT = '/tmp/claude-1000/-home-cristian-projects/605c7073-e300-4705-a59c-0b7d7ac036cb/scratchpad/pdp-via-service.html';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const scraper = app.get(MlScraperService);
    // scrapeWithWait is the worker's product-page fetch (returns the Decodo
    // result incl. raw .content). TS-private, but a normal method at runtime.
    const res = await scraper['scrapeWithWait'](URL, SITE, '.nav-footer');
    require('fs').writeFileSync(OUT, res.content ?? '');
    console.log(JSON.stringify({
      decodoStatus: res.decodoStatus,
      targetStatus: res.targetStatus,
      error: res.error ?? null,
      bytes: (res.content ?? '').length,
      out: OUT,
    }));
  } finally {
    await app.close();
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
