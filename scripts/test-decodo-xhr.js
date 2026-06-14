/**
 * XHR-capture test for Decodo against MercadoLibre.
 *
 * Goal: find out whether Decodo's `xhr: true` output mode lets us pull ML data
 * as STRUCTURED JSON straight from the XHR/Fetch calls the page makes, instead of
 * parsing rendered HTML. If the useful data (price, reviews, sold count, seller,
 * catalog id, best-seller list) arrives via an internal JSON API, capturing it
 * would sidestep both cheerio parsing AND the streaming-SSR partial-render race.
 *
 * `xhr: true` is an OUTPUT mode (Raw HTML / Markdown / XHR in the dashboard): the
 * response `content` becomes the list of XHR/Fetch resources the browser issued,
 * each with url, method, status_code, request/response headers and response_body.
 * Decodo's docs warn "xhr output is not supported by all Target Templates", so
 * this script is exploratory — it dumps everything captured so we can judge.
 *
 * Does NOT touch the DB. For each target it prints every captured XHR (url,
 * method, status, body size, looks-like-JSON) and flags the ML-API-looking ones,
 * then writes the full capture to tmp/decodo-xhr/ for inspection.
 *
 * Run:
 *   node scripts/test-decodo-xhr.js
 *
 * Required env (.env or shell): DECODO_API_TOKEN
 * Optional env:
 *   XHR_SITE=MCO
 *   XHR_CATEGORY=MCO175794          parent ml_id → /mas-vendidos URL (empty to skip)
 *   XHR_PRODUCT=<url>               a product URL to test (defaults to a known MCO one)
 *   XHR_WAIT_S=7                    seconds to wait so XHRs have time to fire
 *   XHR_SCROLL_S=4                  scroll_to_bottom seconds (triggers lazy XHRs)
 *   XHR_RATE_LIMIT=10
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';
const DUMP_DIR = path.join(__dirname, '..', 'tmp', 'decodo-xhr');

const SITE_DOMAINS = {
  MLA: 'mercadolibre.com.ar', MLB: 'mercadolivre.com.br', MLM: 'mercadolibre.com.mx',
  MLC: 'mercadolibre.cl', MCO: 'mercadolibre.com.co', MLU: 'mercadolibre.com.uy',
  MPE: 'mercadolibre.com.pe',
};
const SITE_GEO = { MLA: 'ar', MLB: 'br', MLM: 'mx', MLC: 'cl', MCO: 'co', MLU: 'uy', MPE: 'pe' };

const TOKEN = process.env.DECODO_API_TOKEN;
const SITE = process.env.XHR_SITE || 'MCO';
const CATEGORY = process.env.XHR_CATEGORY ?? 'MCO175794';
const PRODUCT = process.env.XHR_PRODUCT ??
  'https://www.mercadolibre.com.co/audifonos-jbl-t110-in-ear-negro-color-black/p/MCO6344841';
const WAIT_S = parseInt(process.env.XHR_WAIT_S || '7', 10);
const SCROLL_S = parseInt(process.env.XHR_SCROLL_S || '4', 10);
const RATE_LIMIT_PER_SEC = parseInt(process.env.XHR_RATE_LIMIT || '10', 10);

if (!TOKEN) {
  console.error('ERROR: DECODO_API_TOKEN is not set. Add it to .env.');
  process.exit(1);
}
const domain = SITE_DOMAINS[SITE];
if (!domain) {
  console.error(`ERROR: unknown XHR_SITE ${SITE}. Valid: ${Object.keys(SITE_DOMAINS).join(', ')}`);
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

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function looksJson(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return t.startsWith('{') || t.startsWith('[');
}

// Heuristic: an XHR worth our attention — an ML/marketplace API endpoint likely
// to carry product/price/review/seller/search data (not assets, tracking, fonts).
function isInteresting(url) {
  if (!url) return false;
  if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ico|mp4)(\?|$)/i.test(url)) return false;
  if (/google|gstatic|facebook|hotjar|newrelic|datadog|melidata|metric|track|beacon|analytics/i.test(url)) return false;
  return /api|mercadol|\/products?\/|\/items?\/|reviews|price|seller|search|catalog|p\/MCO|recommend/i.test(url);
}

async function captureXhr(label, url) {
  const started = Date.now();
  const body = {
    url,
    proxy_pool: 'premium',
    headless: 'html',
    geo: SITE_GEO[SITE],
    xhr: true,
    browser_actions: [
      { type: 'wait', wait_time_s: WAIT_S },
      { type: 'scroll_to_bottom', timeout_s: SCROLL_S },
    ],
  };
  await rateLimiter.acquire();
  let res, text;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
    text = await res.text().catch(() => '');
  } catch (err) {
    console.log(`\n[${label}] NETWORK ERROR: ${err.message}`);
    return;
  }
  const elapsed = Date.now() - started;
  console.log('\n' + '='.repeat(82));
  console.log(`[${label}] ${url}`);
  console.log(`  decodo=${res.status} time=${elapsed}ms bodyLen=${fmtBytes(text.length)}`);

  if (!res.ok) {
    console.log(`  DECODO ERROR: ${text.slice(0, 200)}`);
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    fs.writeFileSync(path.join(DUMP_DIR, `${label}-error.txt`), text);
    return;
  }

  let json = {};
  try { json = JSON.parse(text); } catch { /* */ }
  const result = json.results?.[0] ?? {};
  let content = result.content;
  // content may be an array of XHR objects, or a JSON string of one, depending on
  // how Decodo serializes the XHR output — handle both.
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { /* leave as string */ }
  }

  fs.mkdirSync(DUMP_DIR, { recursive: true });
  fs.writeFileSync(path.join(DUMP_DIR, `${label}-full.json`), JSON.stringify(json, null, 2));

  if (!Array.isArray(content)) {
    console.log('  XHR output is NOT an array — this Target Template may not support xhr.');
    console.log('  target_status=' + (result.status_code ?? '-'));
    console.log('  Raw first 400 chars of content:');
    const preview = content == null ? '(no results[0].content in envelope)'
      : typeof content === 'string' ? content : JSON.stringify(content);
    console.log('  ' + String(preview).slice(0, 400));
    console.log(`  Full envelope dumped → ${path.relative(process.cwd(), path.join(DUMP_DIR, `${label}-full.json`))}`);
    return;
  }

  console.log(`  Captured ${content.length} XHR/Fetch resources. Interesting ones flagged ★:`);
  const interesting = [];
  for (const x of content) {
    const xurl = x.url || x.request_url || '';
    const method = x.method || x.request_method || '?';
    const status = x.status_code ?? x.status ?? '-';
    const rbody = x.response_body ?? x.body ?? '';
    const bodyLen = typeof rbody === 'string' ? rbody.length : JSON.stringify(rbody || '').length;
    const hot = isInteresting(xurl);
    if (hot) interesting.push({ xurl, method, status, bodyLen, rbody });
    console.log(
      `   ${hot ? '★' : ' '} ${String(method).padEnd(4)} ${String(status).toString().padStart(3)} ` +
      `${fmtBytes(bodyLen).padStart(8)} ${looksJson(rbody) ? 'JSON' : '    '} ${String(xurl).slice(0, 90)}`,
    );
  }

  console.log(`\n  → ${interesting.length} interesting endpoint(s). Dumping their JSON bodies:`);
  interesting.forEach((x, i) => {
    const file = path.join(DUMP_DIR, `${label}-xhr-${String(i + 1).padStart(2, '0')}.json`);
    fs.writeFileSync(file, typeof x.rbody === 'string' ? x.rbody : JSON.stringify(x.rbody, null, 2));
  });
  console.log(`  Bodies + full capture written to ${path.relative(process.cwd(), DUMP_DIR)}/`);
}

(async () => {
  console.log('='.repeat(82));
  console.log('Decodo xhr:true capture test — MercadoLibre');
  console.log('='.repeat(82));
  console.log(`Site: ${SITE} (${domain}, geo=${SITE_GEO[SITE]})  wait=${WAIT_S}s scroll=${SCROLL_S}s`);

  if (CATEGORY) {
    await captureXhr(`category-${CATEGORY}`, `https://www.${domain}/mas-vendidos/${CATEGORY}`);
  }
  if (PRODUCT) {
    await captureXhr('product', PRODUCT);
  }

  console.log('\nDone. Inspect tmp/decodo-xhr/ — if an ★ endpoint returns the product/price/');
  console.log('reviews/best-seller JSON, we can consume it directly instead of parsing HTML.');
})().catch((err) => { console.error('FATAL:', err); process.exit(1); });
