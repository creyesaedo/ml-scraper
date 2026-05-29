/**
 * Validation script for Bright Data Web Unlocker against MercadoLibre.
 *
 * Goal: prove (or disprove) that Web Unlocker can bypass ML's PoW/anti-bot for
 *   1 category page (/mas-vendidos/{catId}) + N product pages
 * before swapping the production scraper from Decodo to Bright Data.
 *
 * Why Web Unlocker: it renders JavaScript with an internal Chromium engine and
 * exposes the `x-unblock-expect` header, which makes it wait until a given CSS
 * selector (or text) is present before returning the HTML. ML uses streaming SSR
 * (React Server Components), so without this wait the unlocker can return the
 * page mid-stream with only <head> populated — the same head-only problem we hit
 * with Decodo. `x-unblock-expect` is the direct equivalent of Decodo's
 * `wait_for_element` browser action.
 *
 * Run:
 *   node scripts/test-brightdata.js
 *
 * Required env (in .env or shell / GitHub Actions secret):
 *   BRIGHTDATA_API_TOKEN=<API key from Bright Data dashboard, Bearer token>
 *
 * Optional env:
 *   BRIGHTDATA_ZONE=market_analysis      (Web Unlocker zone name)
 *   BRD_TEST_SITE=MLC                    (MLC, MLA, MLB, MLM, ...)
 *   BRD_TEST_CATEGORY=MLC1648            (parent ml_id with a /mas-vendidos page)
 *   BRD_TEST_PRODUCT_LIMIT=20            (max products to scrape from category)
 *   BRD_TEST_CONCURRENCY=5               (parallel product requests)
 *   BRD_TEST_RATE_PER_1K=1.50            (USD per 1000 requests, for cost projection)
 *
 * BILLING NOTE: enabling a custom Web Unlocker feature (x-unblock-expect) makes
 * Bright Data bill 100% of requests — successful AND failed — unlike standard
 * Web Unlocker which only bills successful ones. Factor this into cost math.
 */

// dotenv is optional — on GitHub Actions the env is injected directly.
try {
  require('dotenv').config();
} catch {
  /* no dotenv installed / no .env file — rely on process.env */
}
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const DUMP_DIR = path.join(__dirname, '..', 'tmp', 'brightdata-bad');

const ENDPOINT = 'https://api.brightdata.com/request';

const SITE_DOMAINS = {
  MLA: 'mercadolibre.com.ar',
  MLB: 'mercadolibre.com.br',
  MLM: 'mercadolibre.com.mx',
  MLC: 'mercadolibre.cl',
  MCO: 'mercadolibre.com.co',
  MLU: 'mercadolibre.com.uy',
  MLP: 'mercadolibre.com.pe',
  MLV: 'mercadolibre.com.ve',
  MLD: 'mercadolibre.com.do',
  MLE: 'mercadolibre.com.ec',
};

// 2-letter ISO country code for Web Unlocker's `country` param.
const SITE_COUNTRY = {
  MLA: 'ar', MLB: 'br', MLM: 'mx', MLC: 'cl',
  MCO: 'co', MLU: 'uy', MLP: 'pe', MLV: 've',
  MLD: 'do', MLE: 'ec',
};

const TOKEN = process.env.BRIGHTDATA_API_TOKEN;
const ZONE = process.env.BRIGHTDATA_ZONE || 'market_analysis';
const SITE = process.env.BRD_TEST_SITE || 'MLC';
const CATEGORY = process.env.BRD_TEST_CATEGORY || 'MLC1648';
const PRODUCT_LIMIT = parseInt(process.env.BRD_TEST_PRODUCT_LIMIT || '20', 10);
const CONCURRENCY = parseInt(process.env.BRD_TEST_CONCURRENCY || '5', 10);
const RATE_PER_1K = parseFloat(process.env.BRD_TEST_RATE_PER_1K || '1.50');

const CHALLENGE_THRESHOLD_BYTES = 50_000;

// CSS selectors Web Unlocker waits for (via x-unblock-expect) before returning.
const CATEGORY_EXPECT = 'li.ui-search-layout__item';
const PRODUCT_EXPECT = '.ui-pdp-price';

if (!TOKEN) {
  console.error('ERROR: BRIGHTDATA_API_TOKEN is not set. Add it to .env or as a secret.');
  process.exit(1);
}

const domain = SITE_DOMAINS[SITE];
if (!domain) {
  console.error(`ERROR: unknown SITE ${SITE}. Valid: ${Object.keys(SITE_DOMAINS).join(', ')}`);
  process.exit(1);
}

/**
 * Calls Bright Data Web Unlocker for one URL, waiting (via x-unblock-expect) for
 * `expectSelector` to be present in the rendered DOM before the HTML is returned.
 * Returns { url, content, httpStatus, elapsedMs, error }.
 *
 * format: 'raw' makes Web Unlocker return the target page's raw HTML as the
 * response body (not a JSON envelope).
 */
async function scrapeOne(url, expectSelector) {
  const started = Date.now();
  const body = {
    zone: ZONE,
    url,
    format: 'raw',
    country: SITE_COUNTRY[SITE],
    // x-unblock-expect value is itself a JSON string: {"element": "<css>"}.
    // This forces JS rendering + a wait until the selector appears, fixing ML's
    // streaming-SSR head-only race.
    headers: { 'x-unblock-expect': JSON.stringify({ element: expectSelector }) },
  };

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      url,
      content: '',
      httpStatus: 0,
      elapsedMs: Date.now() - started,
      error: `network: ${err.message}`,
    };
  }

  const elapsedMs = Date.now() - started;
  const content = await res.text().catch(() => '');

  if (!res.ok) {
    return {
      url,
      content: '',
      httpStatus: res.status,
      elapsedMs,
      error: `brightdata http ${res.status}: ${content.slice(0, 200)}`,
    };
  }

  return { url, content, httpStatus: res.status, elapsedMs };
}

function parseCategoryHtml(html) {
  const products = [];
  const $ = cheerio.load(html);
  $('li.ui-search-layout__item').each((_i, el) => {
    const name = $(el).find('.poly-component__title').text().trim();
    const href = $(el).find('a.poly-component__title').attr('href') || '';
    if (href) products.push({ name, url: href.split('#')[0].split('?')[0] });
  });
  return products;
}

function checkProductPageMarkers(html) {
  return {
    hasInitialState: /window\.__PRELOADED_STATE__|"price"\s*:\s*{/i.test(html),
    hasCatalogProductId: /catalogProductId/.test(html),
    hasBreadcrumb: /andes-breadcrumb|"category_id"/.test(html),
  };
}

async function runWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    });
  await Promise.all(workers);
  return out;
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

(async () => {
  console.log('='.repeat(70));
  console.log('Bright Data Web Unlocker — MercadoLibre validation');
  console.log('='.repeat(70));
  console.log(`Zone:        ${ZONE}`);
  console.log(`Site:        ${SITE} (${domain}, country=${SITE_COUNTRY[SITE]})`);
  console.log(`Category:    ${CATEGORY}`);
  console.log(`Product cap: ${PRODUCT_LIMIT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`JS render:   via x-unblock-expect (wait for selector)`);
  console.log('-'.repeat(70));

  // ---------- Step 1: category page ----------
  const catUrl = `https://www.${domain}/mas-vendidos/${CATEGORY}`;
  console.log(`\n[1/2] Scraping category: ${catUrl}`);
  const t0 = Date.now();
  const catRes = await scrapeOne(catUrl, CATEGORY_EXPECT);
  console.log(
    `  http=${catRes.httpStatus} size=${fmtBytes(catRes.content.length)} ` +
    `time=${catRes.elapsedMs}ms`,
  );
  if (catRes.error) console.log(`  ERROR: ${catRes.error}`);

  if (!catRes.content || catRes.content.length < CHALLENGE_THRESHOLD_BYTES) {
    console.log(`  WARN: HTML below ${CHALLENGE_THRESHOLD_BYTES}B — likely PoW/challenge or head-only.`);
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(DUMP_DIR, 'bad-category.html'), catRes.content || '');
    console.log('\nAbort: cannot extract products if category page is incomplete.');
    process.exit(2);
  }

  const products = parseCategoryHtml(catRes.content).slice(0, PRODUCT_LIMIT);
  console.log(`  Parsed ${products.length} products from category HTML.`);
  if (products.length === 0) {
    console.log('  WARN: parsed 0 products — selectors may not match.');
    process.exit(2);
  }

  // ---------- Step 2: product pages ----------
  console.log(`\n[2/2] Scraping ${products.length} product pages (concurrency=${CONCURRENCY})...`);
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const prodResults = await runWithConcurrency(products, CONCURRENCY, async (p, i) => {
    const r = await scrapeOne(p.url, PRODUCT_EXPECT);
    const markers = r.content ? checkProductPageMarkers(r.content) : null;
    const looksReal =
      r.content.length >= CHALLENGE_THRESHOLD_BYTES &&
      markers &&
      (markers.hasInitialState || markers.hasCatalogProductId);
    if (!looksReal && r.content) {
      const slug = String(i + 1).padStart(2, '0');
      fs.writeFileSync(path.join(DUMP_DIR, `bad-${slug}.html`), r.content);
      fs.writeFileSync(path.join(DUMP_DIR, `bad-${slug}.url.txt`), `${p.name}\n${p.url}\n`);
    }
    console.log(
      `  [${String(i + 1).padStart(2, '0')}] http=${r.httpStatus} ` +
      `size=${fmtBytes(r.content.length).padStart(8)} ` +
      `time=${String(r.elapsedMs).padStart(6)}ms ` +
      `${looksReal ? 'OK ' : 'BAD'} ` +
      `${p.name.slice(0, 40)}`,
    );
    if (r.error) console.log(`       ERROR: ${r.error}`);
    return { ...r, looksReal, name: p.name };
  });

  const totalMs = Date.now() - t0;

  // ---------- Summary ----------
  const allResults = [
    { ...catRes, looksReal: catRes.content.length >= CHALLENGE_THRESHOLD_BYTES, name: 'CATEGORY' },
    ...prodResults,
  ];
  const realPages = allResults.filter((r) => r.looksReal).length;
  const totalBytes = allResults.reduce((s, r) => s + r.content.length, 0);
  // With x-unblock-expect enabled, Bright Data bills every request.
  const billable = allResults.length;

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total requests sent:     ${allResults.length}`);
  console.log(`Billable (custom hdr):   ${billable}  (x-unblock-expect → all requests billed)`);
  console.log(`Real pages (>50KB+mark): ${realPages} / ${allResults.length}  ← key success metric`);
  console.log(`Success rate:            ${((realPages / allResults.length) * 100).toFixed(1)}%`);
  console.log(`Total bytes transferred: ${fmtBytes(totalBytes)}`);
  console.log(`Total time:              ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Cost of THIS test run:   $${((billable * RATE_PER_1K) / 1000).toFixed(4)} (at $${RATE_PER_1K.toFixed(2)}/1K)`);

  console.log('-'.repeat(70));
  console.log('Cost projection (billing 100% of requests)');
  console.log('  Assumptions: 21 req/category (1 cat + 20 prod) × 4.33 weeks/month');
  const reqsPerCatPerMonth = 21 * 4.33;
  for (const [label, cats] of [['1 site (~32 cats)', 32], ['Core 8 (~251 cats)', 251], ['All 19 (~484 cats)', 484]]) {
    const reqs = reqsPerCatPerMonth * cats;
    const cost = (reqs * RATE_PER_1K) / 1000;
    console.log(`    ${label.padEnd(22)} ${Math.round(reqs).toLocaleString().padStart(8)} req/mo  →  $${cost.toFixed(2)}/mo`);
  }
  console.log('='.repeat(70));

  if (realPages < allResults.length * 0.8) {
    console.log('\nVERDICT: Web Unlocker failed to bypass ML on >20% of pages.');
    process.exit(1);
  } else {
    console.log('\nVERDICT: Web Unlocker successfully scraped real pages.');
  }
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
