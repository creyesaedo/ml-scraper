/**
 * Audit which parent categories have NO usable /mas-vendidos best-sellers page.
 *
 * Some ML parent categories (vehicles, real estate, services, ...) have no
 * best-sellers ranking. ML does NOT return HTTP 404 for these anymore — it serves
 * a soft page: HTTP 200 with ~117 KB and ZERO product items (verified 2026-06-07:
 * MLC1743 vehicles and a bogus id MLC9999999 both return 200 / 0 items, while
 * MLC1648 electronics returns 200 / 20 items). So the HTTP status_code alone is
 * NOT a reliable signal — the real discriminator is the number of rendered
 * `li.ui-search-layout__item` elements.
 *
 * This script reads parent categories from the DB and issues ONE Decodo request
 * per category (the category page only — no product pages), using the same
 * browser_actions render chain as MlScraperService so the body fully renders,
 * then counts products with cheerio to classify each category:
 *   HAS       — 1+ products rendered
 *   EMPTY     — 200 but 0 products (soft-404 / no best-sellers ranking)
 *   NOT_FOUND — target HTTP >= 400 (hard 404, if any site still does this)
 *   ERROR     — network / Decodo 5xx / partial render after retry (inconclusive)
 * "EMPTY" + "NOT_FOUND" together are the categories without a usable más-vendidos.
 *
 * Run:
 *   node scripts/audit-bestsellers.js
 *
 * Required env (in .env or shell):
 *   DATABASE_URL=<postgres connection string>
 *   DECODO_API_TOKEN=<base64 token from Decodo dashboard>
 *
 * Optional env:
 *   AUDIT_SITES=MLA,MLB,MLC,MLM,MCO,MPE,MLU   (Core 7, default)
 *   AUDIT_RATE_LIMIT=10                        (plan req/s cap)
 *   AUDIT_CONCURRENCY=8                        (parallel category requests)
 */

// Load .env without an extra dependency (Node's built-in loader).
try {
  process.loadEnvFile();
} catch {
  /* no .env file present, or env already exported — fall through */
}
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { Client } = require('pg');

const OUT_DIR = path.join(__dirname, '..', 'tmp', 'bestsellers-audit');
const ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';
// Below this size the render is incomplete (head-only streaming-SSR race).
const CHALLENGE_THRESHOLD_BYTES = 50_000;
// Max attempts per category for transient failures (network, Decodo 4xx/5xx
// "failed" bursts, 429, partial renders).
const MAX_ATTEMPTS = 3;
// Same product-list selector MlScraperService waits for / parseCategoryHtml reads.
const CATEGORY_ITEM_SELECTOR = 'li.ui-search-layout__item';

// Mirrors src/adapters/scraper/ml-parsers.ts
const SITE_DOMAINS = {
  MLA: 'mercadolibre.com.ar',
  MLB: 'mercadolivre.com.br',
  MLM: 'mercadolibre.com.mx',
  MLC: 'mercadolibre.cl',
  MCO: 'mercadolibre.com.co',
  MLU: 'mercadolibre.com.uy',
  MPE: 'mercadolibre.com.pe',
  MLV: 'mercadolibre.com.ve',
  MLD: 'mercadolibre.com.do',
  MLE: 'mercadolibre.com.ec',
};

const SITE_GEO = {
  MLA: 'ar', MLB: 'br', MLM: 'mx', MLC: 'cl',
  MCO: 'co', MLU: 'uy', MPE: 'pe', MLV: 've', MLD: 'do', MLE: 'ec',
};

// Best-sellers slug is language-specific: Brazil (Portuguese) uses mais-vendidos.
const SITE_BESTSELLER_SLUG = { MLB: 'mais-vendidos' };
const DEFAULT_BESTSELLER_SLUG = 'mas-vendidos';

// Sites with no best-sellers section at all — skip without issuing a request.
const SITES_WITHOUT_BESTSELLERS = new Set(['MLD', 'MLV']);

const TOKEN = process.env.DECODO_API_TOKEN;
const SITES = (process.env.AUDIT_SITES || 'MLA,MLB,MLC,MLM,MCO,MPE,MLU')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const RATE_LIMIT_PER_SEC = parseInt(process.env.AUDIT_RATE_LIMIT || '10', 10);
const CONCURRENCY = parseInt(process.env.AUDIT_CONCURRENCY || '8', 10);

if (!TOKEN) {
  console.error('ERROR: DECODO_API_TOKEN is not set. Add it to .env.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Add it to .env.');
  process.exit(1);
}

function categoryUrl(siteId, categoryMlId) {
  const domain = SITE_DOMAINS[siteId] || 'mercadolibre.com.ar';
  const slug = SITE_BESTSELLER_SLUG[siteId] || DEFAULT_BESTSELLER_SLUG;
  return `https://www.${domain}/${slug}/${categoryMlId}`;
}

/**
 * Sliding-window rate limiter: at most RATE_LIMIT_PER_SEC starts per 1000ms.
 */
const rateLimiter = (() => {
  const starts = [];
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
        await new Promise((r) => setTimeout(r, waitMs));
      }
    },
  };
})();

/** Count rendered best-sellers product items in the category HTML. */
function countItems(html) {
  if (!html) return 0;
  return cheerio.load(html)(CATEGORY_ITEM_SELECTOR).length;
}

/**
 * Decodo call for a category page, using the same browser_actions render chain as
 * MlScraperService (wait 4s → scroll → wait_for_element 15s) so the streaming-SSR
 * body fully renders before we count products. A page that genuinely has a
 * best-sellers ranking paints the item selector quickly; one without it waits out
 * the 15s ceiling and comes back with 0 items — that is the MISSING signal.
 *
 * Retries once on a partial render (HTTP 200 but body < 50 KB, the head-only race)
 * and once on Decodo 429. Returns
 *   { content, decodoStatus, targetStatus, items, billable, elapsedMs, error? }.
 */
async function scrapeCategory(url, siteId, attempt = 1) {
  const started = Date.now();
  const body = {
    url,
    proxy_pool: 'premium',
    headless: 'html',
    geo: SITE_GEO[siteId] || 'ar',
    browser_actions: [
      { type: 'wait', wait_time_s: 4 },
      { type: 'scroll_to_bottom', timeout_s: 3 },
      {
        type: 'wait_for_element',
        selector: { type: 'css', value: CATEGORY_ITEM_SELECTOR },
        timeout_s: 15,
      },
    ],
  };

  const retry = async (waitMs) => {
    await new Promise((r) => setTimeout(r, waitMs));
    return scrapeCategory(url, siteId, attempt + 1);
  };
  const canRetry = attempt < MAX_ATTEMPTS;

  await rateLimiter.acquire();
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Basic ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (canRetry) return retry(1000 * attempt);
    return {
      content: '', decodoStatus: 0, targetStatus: null, items: 0,
      billable: false, elapsedMs: Date.now() - started,
      error: `network: ${err.message}`,
    };
  }

  const elapsedMs = Date.now() - started;

  // Decodo per-second cap → back off and retry (not billed).
  if (res.status === 429 && canRetry) {
    return retry(1000);
  }

  // Any other Decodo-side HTTP error (e.g. 400 "Something went wrong" bursts,
  // 5xx) is transient — retry before concluding ERROR.
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (canRetry) return retry(1000 * attempt);
    return {
      content: '', decodoStatus: res.status, targetStatus: null, items: 0,
      billable: false, elapsedMs,
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

  // Partial render (head-only streaming-SSR race): retry before concluding.
  if (
    canRetry &&
    targetStatus &&
    targetStatus < 400 &&
    content.length > 0 &&
    content.length < CHALLENGE_THRESHOLD_BYTES
  ) {
    return retry(0);
  }

  return {
    content,
    decodoStatus: res.status,
    targetStatus,
    items: countItems(content),
    billable: isBillable,
    elapsedMs,
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

/**
 * Classify a category by Decodo result. The reliable signal is the product count,
 * not the HTTP status (ML serves a soft-404: 200 with 0 items).
 *   ERROR     — network / Decodo 5xx / partial render after retry (inconclusive)
 *   NOT_FOUND — target HTTP >= 400 (hard 404)
 *   HAS       — 1+ products rendered
 *   EMPTY     — 200 but 0 products (no usable best-sellers ranking)
 */
function classify(r) {
  if (r.error || r.targetStatus == null) return 'ERROR';
  if (r.targetStatus >= 400) return 'NOT_FOUND';
  // 200 but body never reached full size even after the retry → can't trust 0.
  if (r.content && r.content.length < CHALLENGE_THRESHOLD_BYTES) return 'ERROR';
  return r.items > 0 ? 'HAS' : 'EMPTY';
}

// Verdicts that mean "no usable más-vendidos page".
const MISSING_VERDICTS = new Set(['EMPTY', 'NOT_FOUND']);

/** Retry a DB operation a few times on transient network/connection errors. */
async function withDbRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = /EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|terminating connection|Connection terminated/i.test(
        err.message || '',
      );
      if (i < attempts - 1 && transient) {
        const wait = 1500 * (i + 1);
        console.log(`  DB retry ${i + 1}/${attempts - 1}: ${err.message} (waiting ${wait}ms)`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Read parent categories for ALL requested sites in a single DB hit, up front.
 * Doing this before any scraping means the expensive Decodo phase has zero DB
 * dependency — a transient DB drop mid-run can no longer lose paid-for work.
 * Returns Map<siteId, Array<{ml_id, name}>>.
 */
async function fetchAllParentCategories(sites) {
  return withDbRetry(async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT country, ml_id, name FROM categories
         WHERE country = ANY($1) AND parent_id IS NULL
         ORDER BY country, id ASC`,
        [sites],
      );
      const bySite = new Map();
      for (const s of sites) bySite.set(s, []);
      for (const r of rows) {
        if (!bySite.has(r.country)) bySite.set(r.country, []);
        bySite.get(r.country).push({ ml_id: r.ml_id, name: r.name });
      }
      return bySite;
    } finally {
      await client.end();
    }
  });
}

/** Write JSON + CSV + missing.log reports. Safe to call with partial results. */
function writeReports(allRows, totalMs) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `audit-${stamp}.json`);
  const csvPath = path.join(OUT_DIR, `audit-${stamp}.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify(allRows, null, 2));

  const csvEscape = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvHeader = 'site,ml_id,name,targetStatus,items,verdict,billable,elapsedMs,error';
  const csvLines = allRows.map((r) =>
    [r.site, r.ml_id, r.name, r.targetStatus, r.items, r.verdict, r.billable, r.elapsedMs, r.error]
      .map(csvEscape)
      .join(','),
  );
  fs.writeFileSync(csvPath, [csvHeader, ...csvLines].join('\n') + '\n');

  // Dedicated log with ONLY the categories without a usable más-vendidos page.
  const logPath = path.join(OUT_DIR, `missing-${stamp}.log`);
  const logLines = [
    `# Categorías SIN más-vendidos — ${new Date().toISOString()}`,
    `# sites: ${SITES.join(', ')}`,
    '',
  ];
  for (const site of SITES) {
    const miss = allRows.filter((r) => r.site === site && MISSING_VERDICTS.has(r.verdict));
    if (!miss.length) continue;
    logLines.push(`[${site}] ${miss.length} sin más-vendidos:`);
    for (const r of miss) {
      logLines.push(`  ${r.ml_id.padEnd(10)} ${r.verdict.padEnd(9)} ${r.name}`);
    }
    logLines.push('');
  }
  fs.writeFileSync(logPath, logLines.join('\n') + '\n');

  // ---------- Summary ----------
  const billable = allRows.filter((r) => r.billable).length;
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  for (const site of SITES) {
    const rows = allRows.filter((r) => r.site === site);
    if (!rows.length) continue;
    const missing = rows.filter((r) => MISSING_VERDICTS.has(r.verdict));
    const errored = rows.filter((r) => r.verdict === 'ERROR');
    console.log(
      `${site.padEnd(5)} ${String(rows.length).padStart(3)} checked | ` +
        `${String(missing.length).padStart(3)} sin más-vendidos | ${String(errored.length).padStart(2)} ERROR`,
    );
    if (missing.length) {
      console.log(`      ${missing.map((r) => r.ml_id).join(', ')}`);
    }
  }
  console.log('-'.repeat(70));
  console.log(`Total checked:     ${allRows.length}`);
  console.log(`Billable requests: ${billable}`);
  console.log(`Cost (Free/$19):   $${((billable * 1.5) / 1000).toFixed(4)}`);
  console.log(`Total time:        ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`JSON report:       ${jsonPath}`);
  console.log(`CSV report:        ${csvPath}`);
  console.log(`Missing log:       ${logPath}`);
  console.log('='.repeat(70));
}

(async () => {
  console.log('='.repeat(70));
  console.log('MercadoLibre — best-sellers page audit');
  console.log('='.repeat(70));
  console.log(`Sites:       ${SITES.join(', ')}`);
  console.log(`Rate limit:  ${RATE_LIMIT_PER_SEC} req/s`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log('-'.repeat(70));

  const allRows = [];
  const t0 = Date.now();

  // Single up-front DB read for every site (with retry). No DB calls after this.
  const bySite = await fetchAllParentCategories(SITES);

  try {
    for (const site of SITES) {
      if (SITES_WITHOUT_BESTSELLERS.has(site)) {
        console.log(`\n### ${site} — site has NO best-sellers section, skipping (no requests).`);
        continue;
      }

      const cats = bySite.get(site) || [];
      console.log(`\n### ${site} — ${cats.length} parent categories`);
      if (cats.length === 0) {
        console.log(`  WARN: 0 parent categories in DB for ${site} — categories not synced?`);
        continue;
      }

      try {
        const results = await runWithConcurrency(cats, CONCURRENCY, async (cat) => {
          const url = categoryUrl(site, cat.ml_id);
          const r = await scrapeCategory(url, site);
          const verdict = classify(r);
          const row = {
            site,
            ml_id: cat.ml_id,
            name: cat.name,
            targetStatus: r.targetStatus,
            items: r.items,
            verdict,
            billable: r.billable,
            elapsedMs: r.elapsedMs,
            error: r.error || null,
          };
          console.log(
            `  ${cat.ml_id.padEnd(10)} target=${String(r.targetStatus ?? '-').padStart(4)} ` +
              `items=${String(r.items).padStart(2)} ${verdict.padEnd(9)} ${String(cat.name).slice(0, 40)}` +
              (r.error ? `  [${r.error}]` : ''),
          );
          return row;
        });

        allRows.push(...results);

        const missing = results.filter((x) => MISSING_VERDICTS.has(x.verdict));
        const errored = results.filter((x) => x.verdict === 'ERROR');
        console.log(
          `  → ${site}: ${results.length} checked, ${missing.length} sin más-vendidos, ${errored.length} ERROR`,
        );
        if (missing.length) {
          console.log(`  → ${site} sin más-vendidos: ${missing.map((x) => x.ml_id).join(', ')}`);
        }
      } catch (err) {
        // Don't let one site's failure discard the others' (already-paid) results.
        console.log(`  ERROR scraping ${site}: ${err.message} — skipping rest of ${site}`);
      }
    }
  } finally {
    // Always flush whatever we collected, even on a fatal mid-run error.
    writeReports(allRows, Date.now() - t0);
  }
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
