/**
 * Browser-actions variant test for Decodo against MercadoLibre.
 *
 * Goal: find the most reliable browser_actions configuration for the heavy MCO
 * category pages that intermittently return target_status 613 ("Decodo failed to
 * scrape") under the current chain. We found (manual probe) that a category which
 * 613s WITH `wait_for_element` renders fully (475 KB, 20 products) WITHOUT it — so
 * the chain itself is implicated. This script measures four variants side by side
 * on the same URLs so we can pick the best one with data, not a guess.
 *
 * Variants:
 *   baseline      wait 4s → scroll_to_bottom 3s → wait_for_element 15s   (production today)
 *   skip_on_error same chain, but wait_for_element has on_error:"skip"
 *                 (let the action fail soft and return whatever HTML is there
 *                  instead of erroring the whole scrape into a 613)
 *   no_wfe        wait 7s → scroll_to_bottom 4s   (no wait_for_element at all)
 *   success_613   baseline chain + successful_status_codes:[613]
 *                 (tells Decodo to treat 613 as success and return its content —
 *                  this run answers "does a 613 carry any salvageable body?")
 *
 * Does NOT touch the DB. Per target it reports decodo/target status, HTML size,
 * whether it looks like a real page, and (for category pages) how many products
 * parsed — the real success signal.
 *
 * Run:
 *   node scripts/test-decodo-browser-actions.js
 *
 * Required env (.env or shell): DECODO_API_TOKEN
 * Optional env:
 *   BA_SITE=MCO
 *   BA_CATEGORIES=MCO175794,MCO180800   parent ml_ids → /mas-vendidos URLs
 *   BA_PRODUCTS=                        comma-separated product URLs to also test
 *   BA_VARIANTS=all                     'all' or comma list of variant names above
 *   BA_ROUNDS=1                         repeat the whole matrix N times
 *   BA_CONCURRENCY=4                    parallel requests
 *   BA_RATE_LIMIT=10                    plan req/s cap
 */

require('dotenv').config();
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';
const DUMP_DIR = path.join(__dirname, '..', 'tmp', 'decodo-ba');

const SITE_DOMAINS = {
  MLA: 'mercadolibre.com.ar', MLB: 'mercadolivre.com.br', MLM: 'mercadolibre.com.mx',
  MLC: 'mercadolibre.cl', MCO: 'mercadolibre.com.co', MLU: 'mercadolibre.com.uy',
  MPE: 'mercadolibre.com.pe',
};
const SITE_GEO = { MLA: 'ar', MLB: 'br', MLM: 'mx', MLC: 'cl', MCO: 'co', MLU: 'uy', MPE: 'pe' };

const TOKEN = process.env.DECODO_API_TOKEN;
const SITE = process.env.BA_SITE || 'MCO';
const CATEGORIES = (process.env.BA_CATEGORIES ?? 'MCO175794,MCO180800')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PRODUCTS = (process.env.BA_PRODUCTS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ROUNDS = parseInt(process.env.BA_ROUNDS || '1', 10);
const CONCURRENCY = parseInt(process.env.BA_CONCURRENCY || '4', 10);
const RATE_LIMIT_PER_SEC = parseInt(process.env.BA_RATE_LIMIT || '10', 10);

const CHALLENGE_THRESHOLD_BYTES = 50_000;
const CATEGORY_SELECTOR = 'li.ui-search-layout__item';
const PRODUCT_SELECTOR = '.ui-pdp-price';

if (!TOKEN) {
  console.error('ERROR: DECODO_API_TOKEN is not set. Add it to .env.');
  process.exit(1);
}
const domain = SITE_DOMAINS[SITE];
if (!domain) {
  console.error(`ERROR: unknown BA_SITE ${SITE}. Valid: ${Object.keys(SITE_DOMAINS).join(', ')}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rateLimiter = (() => {
  const starts = [];
  return {
    async acquire() {
      while (true) {
        const now = Date.now();
        while (starts.length && now - starts[0] >= 1000) starts.shift();
        if (starts.length < RATE_LIMIT_PER_SEC) { starts.push(now); return; }
        await sleep(1000 - (now - starts[0]) + 1);
      }
    },
  };
})();

const authHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `Basic ${TOKEN}`,
};

// --- the four variants: each returns the extra body fields for a given selector ---
function waitForElement(selector, onError) {
  const a = { type: 'wait_for_element', selector: { type: 'css', value: selector }, timeout_s: 15 };
  if (onError) a.on_error = onError;
  return a;
}
const VARIANTS = {
  baseline: (sel) => ({
    browser_actions: [
      { type: 'wait', wait_time_s: 4 },
      { type: 'scroll_to_bottom', timeout_s: 3 },
      waitForElement(sel),
    ],
  }),
  skip_on_error: (sel) => ({
    browser_actions: [
      { type: 'wait', wait_time_s: 4 },
      { type: 'scroll_to_bottom', timeout_s: 3 },
      waitForElement(sel, 'skip'),
    ],
  }),
  no_wfe: () => ({
    browser_actions: [
      { type: 'wait', wait_time_s: 7 },
      { type: 'scroll_to_bottom', timeout_s: 4 },
    ],
  }),
  success_613: (sel) => ({
    browser_actions: [
      { type: 'wait', wait_time_s: 4 },
      { type: 'scroll_to_bottom', timeout_s: 3 },
      waitForElement(sel),
    ],
    successful_status_codes: [613],
  }),
};

function billableFor(targetStatus, contentLen) {
  return (
    targetStatus === 200 || targetStatus === 204 ||
    (typeof targetStatus === 'number' && targetStatus >= 400 && targetStatus < 500 && contentLen > 0)
  );
}

async function scrape(url, extraBody) {
  const started = Date.now();
  const body = { url, proxy_pool: 'premium', headless: 'html', geo: SITE_GEO[SITE], ...extraBody };
  await rateLimiter.acquire();
  let res;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
  } catch (err) {
    return { content: '', decodoStatus: 0, targetStatus: null, elapsedMs: Date.now() - started, error: `network: ${err.message}` };
  }
  const decodoStatus = res.status;
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    return { content: '', decodoStatus, targetStatus: null, elapsedMs: Date.now() - started, error: `decodo http ${decodoStatus}: ${text.slice(0, 140)}` };
  }
  let json = {};
  try { json = JSON.parse(text); } catch { /* */ }
  const r = json.results?.[0] || {};
  return { content: r.content || '', decodoStatus, targetStatus: r.status_code ?? null, elapsedMs: Date.now() - started };
}

function classify(target, r) {
  const size = r.content.length;
  let products = null;
  if (target.kind === 'category' && size) {
    try { products = cheerio.load(r.content)('li.ui-search-layout__item').length; } catch { products = 0; }
  }
  const is613 = r.targetStatus === 613;
  const is5xx = typeof r.targetStatus === 'number' && r.targetStatus >= 500 && r.targetStatus < 600;
  const partial = !r.error && (r.targetStatus === null || r.targetStatus < 400) && size > 0 && size < CHALLENGE_THRESHOLD_BYTES;
  const looksReal = size >= CHALLENGE_THRESHOLD_BYTES &&
    (target.kind === 'category' ? products > 0 : /ui-pdp-price|"price"\s*:\s*{|catalogProductId/i.test(r.content));
  return { ...r, size, products, is613, is5xx, partial, looksReal, billable: billableFor(r.targetStatus, size) };
}

async function runWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) { const i = cursor++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
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
  const targets = [
    ...CATEGORIES.map((cat) => ({ kind: 'category', label: cat, selector: CATEGORY_SELECTOR, url: `https://www.${domain}/mas-vendidos/${cat}` })),
    ...PRODUCTS.map((url, i) => ({ kind: 'product', label: `prod${i + 1}`, selector: PRODUCT_SELECTOR, url })),
  ];
  const variantNames = (process.env.BA_VARIANTS && process.env.BA_VARIANTS !== 'all')
    ? process.env.BA_VARIANTS.split(',').map((s) => s.trim()).filter((v) => VARIANTS[v])
    : Object.keys(VARIANTS);

  console.log('='.repeat(82));
  console.log('Decodo browser_actions variant test — MercadoLibre');
  console.log('='.repeat(82));
  console.log(`Site:        ${SITE} (${domain}, geo=${SITE_GEO[SITE]})`);
  console.log(`Targets:     ${targets.map((t) => t.label).join(', ')}`);
  console.log(`Variants:    ${variantNames.join(', ')}`);
  console.log(`Rounds:      ${ROUNDS}   Concurrency: ${CONCURRENCY}   Rate cap: ${RATE_LIMIT_PER_SEC}/s`);
  const estReq = variantNames.length * targets.length * ROUNDS;
  console.log(`Est. billed: ~${estReq} requests (~$${((estReq * 1.25) / 1000).toFixed(3)} at $49 tier)`);
  console.log('-'.repeat(82));

  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const summary = {}; // variant -> results[]

  for (const variant of variantNames) {
    const jobs = [];
    for (let r = 0; r < ROUNDS; r++) for (const t of targets) jobs.push(t);
    console.log(`\n[${variant}]`);
    const results = await runWithConcurrency(jobs, CONCURRENCY, async (t) => {
      const r = classify(t, await scrape(t.url, VARIANTS[variant](t.selector)));
      const tag = r.looksReal ? 'OK ' : (r.is613 ? '613' : (r.partial ? 'PRT' : (r.error ? 'ERR' : 'BAD')));
      console.log(
        `  ${tag} ${t.label.padEnd(12)} d=${String(r.decodoStatus).padStart(3)} t=${String(r.targetStatus ?? '-').padStart(3)} ` +
        `${fmtBytes(r.size).padStart(8)} ${String(r.elapsedMs).padStart(6)}ms ` +
        `${t.kind === 'category' ? `prod=${String(r.products ?? '-').padStart(2)} ` : '       '}` +
        `${r.error ? 'ERR:' + r.error.slice(0, 40) : ''}`,
      );
      // keep the raw HTML of the best result per variant+target for inspection
      if (r.looksReal) {
        fs.writeFileSync(path.join(DUMP_DIR, `${variant}-${t.label}.html`), r.content);
      }
      return r;
    });
    summary[variant] = results;
  }

  // ---------- comparison table ----------
  console.log('\n' + '='.repeat(82));
  console.log('SUMMARY (per variant)');
  console.log('='.repeat(82));
  console.log(
    'variant'.padEnd(14) + 'N'.padStart(4) + 'OK'.padStart(5) + 'OK%'.padStart(8) +
    '613'.padStart(5) + 'PRT'.padStart(5) + 'ERR'.padStart(5) +
    'avgProd'.padStart(9) + 'med ms'.padStart(9) + 'bill'.padStart(6),
  );
  console.log('-'.repeat(82));
  for (const v of variantNames) {
    const rs = summary[v];
    const n = rs.length;
    const ok = rs.filter((r) => r.looksReal).length;
    const c613 = rs.filter((r) => r.is613).length;
    const prt = rs.filter((r) => r.partial).length;
    const err = rs.filter((r) => r.error).length;
    const prods = rs.filter((r) => r.products != null).map((r) => r.products);
    const avgProd = prods.length ? (prods.reduce((s, x) => s + x, 0) / prods.length).toFixed(1) : '-';
    const lat = rs.map((r) => r.elapsedMs).sort((a, b) => a - b);
    const med = lat[Math.floor(lat.length / 2)] || 0;
    const bill = rs.filter((r) => r.billable).length;
    console.log(
      v.padEnd(14) + String(n).padStart(4) + String(ok).padStart(5) + `${((ok / n) * 100).toFixed(0)}%`.padStart(8) +
      String(c613).padStart(5) + String(prt).padStart(5) + String(err).padStart(5) +
      String(avgProd).padStart(9) + String(med).padStart(9) + String(bill).padStart(6),
    );
  }
  console.log('='.repeat(82));
  console.log('OK = full page (category: >50KB AND products>0). 613 = render failure.');
  console.log('PRT = partial render (<50KB). avgProd = mean products parsed per category page.');
  console.log(`Best full-page HTML per variant dumped to ${path.relative(process.cwd(), DUMP_DIR)}/`);
})().catch((err) => { console.error('FATAL:', err); process.exit(1); });
