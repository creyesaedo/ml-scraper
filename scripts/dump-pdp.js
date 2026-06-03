/**
 * One-off helper: dumps the raw HTML of a single MercadoLibre PDP via Decodo so
 * we can confirm the inline-JSON keys for new fields (installments, stock, ...)
 * before writing any parser regex.
 *
 * Scrapes a category's best-sellers page, takes the first product URL, scrapes
 * that PDP, and writes the HTML to tmp/pdp-sample.html. Uses the same
 * browser_actions chain as MlScraperService / test-decodo.js.
 *
 * Run:  node scripts/dump-pdp.js
 * Env:  DECODO_API_TOKEN (required), DECODO_TEST_SITE=MLC, DECODO_TEST_CATEGORY=MLC1276
 */
require('dotenv').config();
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';
const SITE_DOMAINS = { MLA: 'mercadolibre.com.ar', MLB: 'mercadolivre.com.br', MLM: 'mercadolibre.com.mx', MLC: 'mercadolibre.cl', MCO: 'mercadolibre.com.co', MLU: 'mercadolibre.com.uy', MPE: 'mercadolibre.com.pe' };
const SITE_GEO = { MLA: 'ar', MLB: 'br', MLM: 'mx', MLC: 'cl', MCO: 'co', MLU: 'uy', MPE: 'pe' };

const TOKEN = process.env.DECODO_API_TOKEN;
const SITE = process.env.DECODO_TEST_SITE || 'MLC';
const CATEGORY = process.env.DECODO_TEST_CATEGORY || 'MLC1276';

if (!TOKEN) { console.error('ERROR: DECODO_API_TOKEN not set'); process.exit(1); }
const domain = SITE_DOMAINS[SITE];

async function scrapeOne(url, waitSelector) {
  const body = {
    url, proxy_pool: 'premium', headless: 'html', geo: SITE_GEO[SITE],
    browser_actions: [
      { type: 'wait', wait_time_s: 4 },
      { type: 'scroll_to_bottom', timeout_s: 3 },
      { type: 'wait_for_element', selector: { type: 'css', value: waitSelector }, timeout_s: 15 },
    ],
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return json.results?.[0]?.content || '';
}

(async () => {
  const catUrl = `https://www.${domain}/mas-vendidos/${CATEGORY}`;
  console.log(`[1/2] category: ${catUrl}`);
  const catHtml = await scrapeOne(catUrl, 'li.ui-search-layout__item');
  const $ = cheerio.load(catHtml);
  const href = $('li.ui-search-layout__item a.poly-component__title').first().attr('href') || '';
  const pdpUrl = href.split('#')[0].split('?')[0];
  if (!pdpUrl) { console.error('No product URL found in category page'); process.exit(2); }

  console.log(`[2/2] PDP: ${pdpUrl}`);
  const pdpHtml = await scrapeOne(pdpUrl, '.ui-pdp-price');
  const dir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'pdp-sample.html');
  fs.writeFileSync(out, pdpHtml);
  console.log(`Saved ${(pdpHtml.length / 1024).toFixed(1)}KB → ${out}`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
