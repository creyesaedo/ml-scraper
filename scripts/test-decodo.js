/**
 * Validation script for Decodo Web Scraping API against MercadoLibre.
 *
 * Goal: prove (or disprove) that Decodo can bypass ML's PoW/anti-bot for
 *   1 category page (/mas-vendidos/{catId}) + N product pages
 * before committing to a paid plan.
 *
 * Run:
 *   node scripts/test-decodo.js
 *
 * Required env (in .env or shell):
 *   DECODO_API_TOKEN=<base64 token from Decodo dashboard>
 *
 * Optional env:
 *   DECODO_TEST_SITE=MLC                 (MLC, MLA, MLB, MLM, ...)
 *   DECODO_TEST_CATEGORY=MLC1512         (parent ml_id)
 *   DECODO_TEST_PRODUCT_LIMIT=20         (max products to scrape from category)
 *   DECODO_TEST_CONCURRENCY=5            (parallel product requests)
 */

require('dotenv').config();
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const DUMP_DIR = path.join(__dirname, '..', 'tmp', 'decodo-bad');

const ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';

const SITE_DOMAINS = {
  MLA: 'mercadolibre.com.ar',
  MLB: 'mercadolivre.com.br',
  MLM: 'mercadolibre.com.mx',
  MLC: 'mercadolibre.cl',
  MCO: 'mercadolibre.com.co',
  MLU: 'mercadolibre.com.uy',
  MPE: 'mercadolibre.com.pe',
};

const SITE_GEO = {
  MLA: 'ar', MLB: 'br', MLM: 'mx', MLC: 'cl',
  MCO: 'co', MLU: 'uy', MPE: 'pe',
};

const TOKEN = process.env.DECODO_API_TOKEN;
const SITE = process.env.DECODO_TEST_SITE || 'MLC';
const CATEGORY = process.env.DECODO_TEST_CATEGORY || 'MLC1512';
const PRODUCT_LIMIT = parseInt(process.env.DECODO_TEST_PRODUCT_LIMIT || '20', 10);
const CONCURRENCY = parseInt(process.env.DECODO_TEST_CONCURRENCY || '5', 10);
// Plan caps (req/s): Free/$19=10, $49=25, $99=50, $249=100, $499=150, $999+=200
const RATE_LIMIT_PER_SEC = parseInt(process.env.DECODO_TEST_RATE_LIMIT || '10', 10);
// 'standard' or 'premium'. Rates per 1K req on $99 plan:
//   standard=$0.40, standard+js=$0.60, premium=$0.80, premium+js=$1.20
const PROXY_POOL = process.env.DECODO_TEST_PROXY_POOL || 'premium';

const CHALLENGE_THRESHOLD_BYTES = 50_000;

if (!TOKEN) {
  console.error('ERROR: DECODO_API_TOKEN is not set. Add it to .env.');
  process.exit(1);
}

const domain = SITE_DOMAINS[SITE];
if (!domain) {
  console.error(`ERROR: unknown SITE ${SITE}. Valid: ${Object.keys(SITE_DOMAINS).join(', ')}`);
  process.exit(1);
}

/**
 * Calls Decodo Web Scraping API for one URL with premium proxy + JS rendering.
 * Returns { content, decodoStatus, targetStatus, billable, elapsedMs }.
 *
 * Billing rule (per docs):
 *   - 200, 204 → billed
 *   - 4xx with non-empty body → billed
 *   - 5xx, 524, 613 → NOT billed
 */
/**
 * Sliding-window rate limiter: at most RATE_LIMIT_PER_SEC starts in any 1000ms window.
 * Callers `await rateLimiter.acquire()` before sending a request — it blocks until
 * a slot frees up. Plan caps: Free/$19=10, $49=25, $99=50, $249=100.
 */
const rateLimiter = (() => {
  const starts = []; // timestamps (ms) of recent request starts
  return {
    async acquire() {
      while (true) {
        const now = Date.now();
        while (starts.length && now - starts[0] >= 1000) starts.shift();
        if (starts.length < RATE_LIMIT_PER_SEC) {
          starts.push(now);
          return;
        }
        const waitMs = 1000 - (now - starts[0]) + 1;
        await new Promise(r => setTimeout(r, waitMs));
      }
    },
  };
})();

/**
 * waitSelector: optional CSS selector to wait for before returning HTML.
 * Used for product pages — Decodo's headless browser otherwise sometimes returns
 * after only the <head> renders (~9KB), even on success. Waiting for a body-level
 * selector forces a complete render.
 *
 * Handles HTTP 429 from Decodo with one bounded retry (waits 1s then retries once).
 */
async function scrapeOne(url, waitSelector = null, _retried = false) {
  const started = Date.now();
  const body = {
    url,
    proxy_pool: PROXY_POOL,
    headless: 'html',
    geo: SITE_GEO[SITE],
  };
  if (waitSelector) {
    // ML uses streaming SSR — the body arrives in chunks. Decodo's headless
    // sometimes captures HTML before all chunks land, leaving only <head>.
    // Strategy: hard 4s pause (gives streaming time) → scroll (triggers any
    // lazy hydration) → wait_for_element (verifies render finished).
    body.browser_actions = [
      { type: 'wait', wait_time_s: 4 },
      { type: 'scroll_to_bottom', timeout_s: 3 },
      {
        // Matches MlScraperService: 15s ceiling, but wait_for_element exits as
        // soon as the selector appears, so healthy pages are not slowed.
        type: 'wait_for_element',
        selector: { type: 'css', value: waitSelector },
        timeout_s: 15,
      },
    ];
  }

  await rateLimiter.acquire();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Basic ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      url,
      content: '',
      decodoStatus: 0,
      targetStatus: null,
      billable: false,
      elapsedMs: Date.now() - started,
      error: `network: ${err.message}`,
    };
  }

  const elapsedMs = Date.now() - started;

  // Decodo returns 429 when the per-second cap of the plan is exceeded.
  // Back off briefly and retry once. Not billed (it's a Decodo-side rejection,
  // not a scrape).
  if (res.status === 429 && !_retried) {
    await new Promise(r => setTimeout(r, 1000));
    return scrapeOne(url, waitSelector, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      url,
      content: '',
      decodoStatus: res.status,
      targetStatus: null,
      billable: false,
      elapsedMs,
      error: `decodo http ${res.status}: ${text.slice(0, 200)}`,
    };
  }

  const json = await res.json();
  const result = json.results?.[0] || {};
  const content = result.content || '';
  const targetStatus = result.status_code || null;

  const isBillable =
    targetStatus === 200 ||
    targetStatus === 204 ||
    (targetStatus >= 400 && targetStatus < 500 && content.length > 0);

  return {
    url,
    content,
    decodoStatus: res.status,
    targetStatus,
    billable: isBillable,
    elapsedMs,
  };
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
  // Heuristic: real ML product pages have these inline JSON blobs / DOM markers.
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
  console.log('Decodo Web Scraping API — MercadoLibre validation');
  console.log('='.repeat(70));
  console.log(`Site:        ${SITE} (${domain}, geo=${SITE_GEO[SITE]})`);
  console.log(`Category:    ${CATEGORY}`);
  console.log(`Product cap: ${PRODUCT_LIMIT}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Rate limit:  ${RATE_LIMIT_PER_SEC} req/s (plan cap)`);
  console.log(`Proxy pool:  ${PROXY_POOL} + JS rendering`);
  console.log('-'.repeat(70));

  // ---------- Step 1: category page ----------
  const catUrl = `https://www.${domain}/mas-vendidos/${CATEGORY}`;
  console.log(`\n[1/2] Scraping category: ${catUrl}`);
  const t0 = Date.now();
  // Same SSR streaming bug affects /mas-vendidos pages; wait for the product list.
  const catRes = await scrapeOne(catUrl, 'li.ui-search-layout__item');
  console.log(
    `  decodo=${catRes.decodoStatus} target=${catRes.targetStatus} ` +
    `size=${fmtBytes(catRes.content.length)} time=${catRes.elapsedMs}ms ` +
    `billable=${catRes.billable}`,
  );
  if (catRes.error) console.log(`  ERROR: ${catRes.error}`);

  if (!catRes.content || catRes.content.length < CHALLENGE_THRESHOLD_BYTES) {
    console.log(`  WARN: HTML below ${CHALLENGE_THRESHOLD_BYTES}B — likely PoW challenge page.`);
    console.log('\nAbort: cannot extract products if category page is a challenge.');
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
  // Wait for .ui-pdp-price (price block on every product detail page) so Decodo
  // doesn't return mid-render with only the <head>.
  const prodResults = await runWithConcurrency(products, CONCURRENCY, async (p, i) => {
    const r = await scrapeOne(p.url, '.ui-pdp-price');
    const markers = r.content ? checkProductPageMarkers(r.content) : null;
    const looksReal =
      r.content.length >= CHALLENGE_THRESHOLD_BYTES &&
      markers &&
      (markers.hasInitialState || markers.hasCatalogProductId);
    if (!looksReal && r.content) {
      const slug = String(i + 1).padStart(2, '0');
      const file = path.join(DUMP_DIR, `bad-${slug}.html`);
      fs.writeFileSync(file, r.content);
      const urlFile = path.join(DUMP_DIR, `bad-${slug}.url.txt`);
      fs.writeFileSync(urlFile, `${p.name}\n${p.url}\n`);
    }
    console.log(
      `  [${String(i + 1).padStart(2, '0')}] target=${r.targetStatus} ` +
      `size=${fmtBytes(r.content.length).padStart(8)} ` +
      `time=${String(r.elapsedMs).padStart(5)}ms ` +
      `${looksReal ? 'OK ' : 'BAD'} ` +
      `bill=${r.billable ? 'Y' : 'N'} ` +
      `${p.name.slice(0, 40)}`,
    );
    if (r.error) console.log(`       ERROR: ${r.error}`);
    return { ...r, looksReal, name: p.name };
  });

  const totalMs = Date.now() - t0;

  // ---------- Summary ----------
  const allResults = [{ ...catRes, looksReal: catRes.content.length >= CHALLENGE_THRESHOLD_BYTES, name: 'CATEGORY' }, ...prodResults];
  const billable = allResults.filter(r => r.billable).length;
  const realPages = allResults.filter(r => r.looksReal).length;
  const totalBytes = allResults.reduce((s, r) => s + r.content.length, 0);

  // Decodo pricing model: pay-per-request. The plan you commit to determines the per-1K rate.
  // (Premium proxies + JS rendering rates, from dashboard/scrapers/pricing as of 2026-05.)
  const TIERS = [
    { plan: 'Free/$19', commit: 19, ratePer1K: 1.50 },
    { plan: '$49',      commit: 49, ratePer1K: 1.25 },
    { plan: '$99',      commit: 99, ratePer1K: 1.20 },
    { plan: '$249',     commit: 249, ratePer1K: 1.15 },
    { plan: '$499',     commit: 499, ratePer1K: 1.10 },
    { plan: '$999',     commit: 999, ratePer1K: 1.05 },
    { plan: '$1499',    commit: 1499, ratePer1K: 1.00 },
  ];

  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total requests sent:     ${allResults.length}`);
  console.log(`Billable (per Decodo):   ${billable}`);
  console.log(`Real pages (>50KB+mark): ${realPages} / ${allResults.length}  ← key success metric`);
  console.log(`Success rate:            ${((realPages / allResults.length) * 100).toFixed(1)}%`);
  console.log(`Total bytes transferred: ${fmtBytes(totalBytes)}`);
  console.log(`Total time:              ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`Cost of THIS test run:   $${((billable * 1.5) / 1000).toFixed(4)} (Free/$19 rate, used from trial credit)`);

  console.log('-'.repeat(70));
  console.log('Pay-per-request cost projection');
  console.log('  Assumptions: 1 site = 484 categories × 21 req/cat × 4.33 weeks/month');
  console.log('  Scaling from this test:');
  const reqsPerMonth1Site = billable * 484 * 4.33;
  console.log(`    Billable req/month, 1 site:  ${Math.round(reqsPerMonth1Site).toLocaleString()}`);
  console.log(`    Billable req/month, 2 sites: ${Math.round(reqsPerMonth1Site * 2).toLocaleString()}`);
  console.log(`    Billable req/month, 4 sites: ${Math.round(reqsPerMonth1Site * 4).toLocaleString()}`);

  console.log('\n  Real monthly cost (= req × tier rate) per plan tier:');
  console.log('  ' + 'Plan'.padEnd(10) + 'Rate/1K'.padEnd(10) + '1 site'.padEnd(12) + '2 sites'.padEnd(12) + '4 sites'.padEnd(12) + 'Min plan?');
  for (const t of TIERS) {
    const c1 = (reqsPerMonth1Site * t.ratePer1K) / 1000;
    const c2 = c1 * 2;
    const c4 = c1 * 4;
    // "Min plan" = is this tier's commit enough to cover the 1-site cost (no overage)
    const covers1Site = c1 <= t.commit ? 'yes (1 site)' : '';
    const covers2 = c2 <= t.commit && !covers1Site ? 'yes (2 sites)' : '';
    const covers4 = c4 <= t.commit && !covers1Site && !covers2 ? 'yes (4 sites)' : '';
    console.log(
      '  ' +
      t.plan.padEnd(10) +
      `$${t.ratePer1K.toFixed(2)}`.padEnd(10) +
      `$${c1.toFixed(2)}`.padEnd(12) +
      `$${c2.toFixed(2)}`.padEnd(12) +
      `$${c4.toFixed(2)}`.padEnd(12) +
      (covers1Site || covers2 || covers4),
    );
  }
  console.log('\n  NOTE: "covers" assumes no overage allowed. If Decodo charges overage');
  console.log('  at the tier rate, you can pick a smaller plan and pay overage instead.');
  console.log('='.repeat(70));

  if (realPages < allResults.length * 0.8) {
    console.log('\nVERDICT: Decodo failed to bypass ML on >20% of pages.');
    process.exit(1);
  } else {
    console.log('\nVERDICT: Decodo successfully scraped real pages.');
  }
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
