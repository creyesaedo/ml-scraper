/**
 * A/B validation: Decodo SYNC (/v2/scrape) vs ASYNC (/v3/task) for MercadoLibre.
 *
 * Goal: find out, empirically, whether Decodo's asynchronous task mode prevents
 * the transient HTTP 400 "Something went wrong. Please try again later" bursts
 * we hit on MCO (Colombia) with the synchronous endpoint. The hypothesis is that
 * those 400s are synchronous-render-window failures (Decodo must finish a ~22s
 * browser_actions render inside the HTTP request, and its premium+headless pool
 * rejects with a transient 400 when saturated), and that async mode — where
 * Decodo queues the job and we poll for `done`/`faulted` — decouples us from that
 * window. This script measures it instead of assuming it.
 *
 * It does NOT touch the database. It replays the exact URLs that degraded in the
 * 2026-06-10 MCO run (mco-failed-urls.txt) plus the 2 categories whose listing
 * page failed, through both modes, at production-like concurrency, and prints a
 * side-by-side comparison (success rate, 400 rate, latency, billable count).
 *
 * IMPORTANT CAVEAT: the original 400 burst was a time-bounded Decodo-side
 * incident (~21:47–22:50 UTC on 2026-06-10). It may not reproduce on demand. If
 * NEITHER mode shows 400s now, the run is inconclusive about the burst itself —
 * but it still measures async viability, latency, browser_actions support, and
 * baseline success rate, which is what we need before refactoring the service.
 *
 * Run:
 *   node scripts/test-decodo-async-ab.js
 *
 * Required env (.env or shell):
 *   DECODO_API_TOKEN=<base64 token>
 *
 * Optional env:
 *   AB_SITE=MCO                  site id (geo + domain)
 *   AB_MODES=both                'sync' | 'async' | 'both'
 *   AB_SAMPLE=12                 max product URLs to test (cost guard; 0 = all)
 *   AB_ROUNDS=1                  repeat the whole batch N times (more volume to
 *                                catch an intermittent transient)
 *   AB_CONCURRENCY=10            parallel requests (match production to stress the
 *                                render pool the way the real run did)
 *   AB_RATE_LIMIT=10             plan req/s cap (Free/$19=10)
 *   AB_URL_FILE=mco-failed-urls.txt   file with the URLs to replay
 *   AB_CATEGORIES=MCO175794,MCO180800 categories whose listing page to replay
 *   AB_ASYNC_POLL_MS=2000        poll interval for async task status
 *   AB_ASYNC_TIMEOUT_MS=120000   give up on an async task after this long
 *   AB_ASYNC_BROWSER_ACTIONS=1   send browser_actions in async body (1) or not (0)
 */

require('dotenv').config();
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const SYNC_ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';
const TASK_ENDPOINT = 'https://scraper-api.decodo.com/v3/task';
const DUMP_DIR = path.join(__dirname, '..', 'tmp', 'decodo-ab');

const SITE_DOMAINS = {
  MLA: 'mercadolibre.com.ar', MLB: 'mercadolivre.com.br', MLM: 'mercadolibre.com.mx',
  MLC: 'mercadolibre.cl', MCO: 'mercadolibre.com.co', MLU: 'mercadolibre.com.uy',
  MPE: 'mercadolibre.com.pe',
};
const SITE_GEO = {
  MLA: 'ar', MLB: 'br', MLM: 'mx', MLC: 'cl', MCO: 'co', MLU: 'uy', MPE: 'pe',
};

const TOKEN = process.env.DECODO_API_TOKEN;
const SITE = process.env.AB_SITE || 'MCO';
const MODES = (process.env.AB_MODES || 'both').toLowerCase();
const SAMPLE = parseInt(process.env.AB_SAMPLE || '12', 10);
const ROUNDS = parseInt(process.env.AB_ROUNDS || '1', 10);
const CONCURRENCY = parseInt(process.env.AB_CONCURRENCY || '10', 10);
const RATE_LIMIT_PER_SEC = parseInt(process.env.AB_RATE_LIMIT || '10', 10);
const URL_FILE = process.env.AB_URL_FILE || 'mco-failed-urls.txt';
const CATEGORIES = (process.env.AB_CATEGORIES ?? 'MCO175794,MCO180800')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ASYNC_POLL_MS = parseInt(process.env.AB_ASYNC_POLL_MS || '2000', 10);
const ASYNC_TIMEOUT_MS = parseInt(process.env.AB_ASYNC_TIMEOUT_MS || '120000', 10);
const ASYNC_BROWSER_ACTIONS = process.env.AB_ASYNC_BROWSER_ACTIONS !== '0';

const CHALLENGE_THRESHOLD_BYTES = 50_000;
const PRODUCT_SELECTOR = '.ui-pdp-price';
const CATEGORY_SELECTOR = 'li.ui-search-layout__item';

if (!TOKEN) {
  console.error('ERROR: DECODO_API_TOKEN is not set. Add it to .env.');
  process.exit(1);
}
const domain = SITE_DOMAINS[SITE];
if (!domain) {
  console.error(`ERROR: unknown AB_SITE ${SITE}. Valid: ${Object.keys(SITE_DOMAINS).join(', ')}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sliding-window limiter: at most RATE_LIMIT_PER_SEC starts per 1000ms window. */
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

/** Builds the scrape body shared by both modes (matches MlScraperService). */
function buildBody(url, selector, withBrowserActions = true) {
  const body = { url, proxy_pool: 'premium', headless: 'html', geo: SITE_GEO[SITE] };
  if (withBrowserActions) {
    body.browser_actions = [
      { type: 'wait', wait_time_s: 4 },
      { type: 'scroll_to_bottom', timeout_s: 3 },
      { type: 'wait_for_element', selector: { type: 'css', value: selector }, timeout_s: 15 },
    ];
  }
  return body;
}

function billableFor(targetStatus, contentLen) {
  return (
    targetStatus === 200 ||
    targetStatus === 204 ||
    (typeof targetStatus === 'number' && targetStatus >= 400 && targetStatus < 500 && contentLen > 0)
  );
}

// --- defensive extractors: the async v3 response shape is not fully documented,
// so we probe several plausible JSON paths and fall back gracefully. ---
function pickTaskId(json) {
  return json?.id ?? json?.task_id ?? json?.results?.[0]?.task_id ?? json?.data?.id ?? null;
}
function pickStatus(json) {
  return json?.status ?? json?.results?.[0]?.status ?? json?.data?.status ?? null;
}
function pickResult(json) {
  const r = json?.results?.[0] ?? json?.result ?? json?.data ?? json ?? {};
  return {
    content: r.content ?? r.html ?? r.body ?? '',
    targetStatus: r.status_code ?? r.statusCode ?? r.target_status ?? null,
  };
}

const dumped = new Set();
function dumpOnce(which, label, payload) {
  const key = `${which}-${label}`;
  if (dumped.has(key)) return;
  dumped.add(key);
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const file = path.join(DUMP_DIR, `${which}-first-${label}.json`);
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
  console.log(`  [debug] dumped first ${which} ${label} → ${path.relative(process.cwd(), file)}`);
}

/** SYNC mode: one /v2/scrape call (the current production path). */
async function scrapeSync(url, selector) {
  const started = Date.now();
  await rateLimiter.acquire();
  let res;
  try {
    res = await fetch(SYNC_ENDPOINT, {
      method: 'POST', headers: authHeaders, body: JSON.stringify(buildBody(url, selector)),
    });
  } catch (err) {
    return result(url, 'sync', '', 0, null, Date.now() - started, `network: ${err.message}`);
  }
  const decodoStatus = res.status;
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    dumpOnce('sync', `http-${decodoStatus}`, text);
    return result(url, 'sync', '', decodoStatus, null, Date.now() - started,
      `decodo http ${decodoStatus}: ${text.slice(0, 160)}`);
  }
  let json = {};
  try { json = JSON.parse(text); } catch { /* leave empty */ }
  const { content, targetStatus } = pickResult(json);
  return result(url, 'sync', content, decodoStatus, targetStatus, Date.now() - started);
}

/** ASYNC mode: submit /v3/task, poll status, fetch results. */
async function scrapeAsync(url, selector) {
  const started = Date.now();

  // 1. submit
  await rateLimiter.acquire();
  let createRes, createText;
  try {
    createRes = await fetch(TASK_ENDPOINT, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify(buildBody(url, selector, ASYNC_BROWSER_ACTIONS)),
    });
    createText = await createRes.text().catch(() => '');
  } catch (err) {
    return result(url, 'async', '', 0, null, Date.now() - started, `network(create): ${err.message}`);
  }
  dumpOnce('async', `create-http-${createRes.status}`, createText);
  if (!createRes.ok) {
    return result(url, 'async', '', createRes.status, null, Date.now() - started,
      `task create http ${createRes.status}: ${createText.slice(0, 160)}`);
  }
  let createJson = {};
  try { createJson = JSON.parse(createText); } catch { /* */ }
  const taskId = pickTaskId(createJson);
  if (!taskId) {
    return result(url, 'async', '', createRes.status, null, Date.now() - started,
      `no task id in create response: ${createText.slice(0, 160)}`);
  }

  // 2. poll status
  let status = null;
  while (Date.now() - started < ASYNC_TIMEOUT_MS) {
    await sleep(ASYNC_POLL_MS);
    await rateLimiter.acquire();
    let statusRes, statusText;
    try {
      statusRes = await fetch(`${TASK_ENDPOINT}/${taskId}`, { headers: authHeaders });
      statusText = await statusRes.text().catch(() => '');
    } catch (err) {
      continue; // transient poll error — keep polling until timeout
    }
    dumpOnce('async', 'status', statusText);
    let statusJson = {};
    try { statusJson = JSON.parse(statusText); } catch { /* */ }
    status = pickStatus(statusJson);
    if (status === 'done' || status === 'faulted') break;
  }
  if (status !== 'done') {
    return result(url, 'async', '', createRes.status, null, Date.now() - started,
      `task ${status ?? 'timeout'} (id=${taskId})`);
  }

  // 3. fetch results
  await rateLimiter.acquire();
  let resultsText;
  try {
    const resultsRes = await fetch(`${TASK_ENDPOINT}/${taskId}/results`, { headers: authHeaders });
    resultsText = await resultsRes.text().catch(() => '');
  } catch (err) {
    return result(url, 'async', '', createRes.status, null, Date.now() - started,
      `network(results): ${err.message}`);
  }
  dumpOnce('async', 'results', resultsText.slice(0, 4000));
  let resultsJson = {};
  try { resultsJson = JSON.parse(resultsText); } catch { /* raw HTML maybe */ }
  let { content, targetStatus } = pickResult(resultsJson);
  if (!content && resultsText && !resultsText.trim().startsWith('{')) {
    content = resultsText; // some result endpoints return raw HTML, not JSON
  }
  return result(url, 'async', content, createRes.status, targetStatus, Date.now() - started);
}

function result(url, mode, content, decodoStatus, targetStatus, elapsedMs, error = null) {
  const markers = content
    ? /window\.__PRELOADED_STATE__|"price"\s*:\s*{|catalogProductId|ui-search-layout__item/i.test(content)
    : false;
  const looksReal = content.length >= CHALLENGE_THRESHOLD_BYTES && markers;
  const is400 = decodoStatus === 400 || targetStatus === 400;
  return {
    url, mode, content, decodoStatus, targetStatus, elapsedMs, error,
    size: content.length, looksReal, is400,
    billable: billableFor(targetStatus, content.length),
  };
}

async function runWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array(Math.min(limit, items.length)).fill(0).map(async () => {
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

/**
 * Reads the URL file, skipping comments/blank lines and re-joining wrapped URLs
 * (a line that does not start with http is a continuation of the previous one —
 * mco-failed-urls.txt has one such wrap).
 */
function loadUrls(file) {
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`ERROR: URL file not found: ${abs}`);
    process.exit(1);
  }
  const urls = [];
  for (const raw of fs.readFileSync(abs, 'utf8').split('\n')) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^https?:\/\//i.test(t)) urls.push(t);
    else if (urls.length) urls[urls.length - 1] += t; // continuation of a wrapped URL
  }
  return urls;
}

function summarize(label, results) {
  const n = results.length;
  if (!n) return null;
  const ok = results.filter((r) => r.looksReal).length;
  const c400 = results.filter((r) => r.is400).length;
  const errs = results.filter((r) => r.error && !r.is400).length;
  const billable = results.filter((r) => r.billable).length;
  const lat = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const median = lat[Math.floor(lat.length / 2)];
  const avg = Math.round(lat.reduce((s, x) => s + x, 0) / n);
  return { label, n, ok, okPct: (ok / n) * 100, c400, errs, billable, avg, median };
}

function printSummaryTable(rows) {
  console.log('\n' + '='.repeat(78));
  console.log('A/B SUMMARY');
  console.log('='.repeat(78));
  console.log(
    'Mode'.padEnd(8) + 'N'.padStart(5) + 'OK'.padStart(6) + 'OK%'.padStart(8) +
    '400'.padStart(6) + 'err'.padStart(6) + 'bill'.padStart(6) +
    'avg ms'.padStart(9) + 'med ms'.padStart(9),
  );
  console.log('-'.repeat(78));
  for (const s of rows) {
    if (!s) continue;
    console.log(
      s.label.padEnd(8) + String(s.n).padStart(5) + String(s.ok).padStart(6) +
      `${s.okPct.toFixed(1)}%`.padStart(8) + String(s.c400).padStart(6) +
      String(s.errs).padStart(6) + String(s.billable).padStart(6) +
      String(s.avg).padStart(9) + String(s.median).padStart(9),
    );
  }
  console.log('='.repeat(78));
}

(async () => {
  const productUrls = loadUrls(URL_FILE).slice(0, SAMPLE > 0 ? SAMPLE : undefined);
  const categoryTargets = CATEGORIES.map((cat) => ({
    url: `https://www.${domain}/mas-vendidos/${cat}`,
    selector: CATEGORY_SELECTOR,
    kind: 'category',
  }));
  const productTargets = productUrls.map((url) => ({ url, selector: PRODUCT_SELECTOR, kind: 'product' }));
  const targets = [...categoryTargets, ...productTargets];

  console.log('='.repeat(78));
  console.log('Decodo SYNC vs ASYNC — MCO error-handling validation');
  console.log('='.repeat(78));
  console.log(`Site:         ${SITE} (${domain}, geo=${SITE_GEO[SITE]})`);
  console.log(`Modes:        ${MODES}`);
  console.log(`Targets:      ${categoryTargets.length} categories + ${productTargets.length} products = ${targets.length}`);
  console.log(`Rounds:       ${ROUNDS}  (total ${targets.length * ROUNDS} URLs per mode)`);
  console.log(`Concurrency:  ${CONCURRENCY}   Rate cap: ${RATE_LIMIT_PER_SEC} req/s`);
  console.log(`Async:        browser_actions=${ASYNC_BROWSER_ACTIONS ? 'on' : 'off'}, poll=${ASYNC_POLL_MS}ms, timeout=${ASYNC_TIMEOUT_MS}ms`);
  console.log(`Source file:  ${URL_FILE}`);
  const estReq = targets.length * ROUNDS * (MODES === 'both' ? 2 : 1);
  console.log(`Est. billed:  ~${estReq} requests (~$${((estReq * 1.5) / 1000).toFixed(3)} at $19 tier) + async poll calls (not billed)`);
  console.log('-'.repeat(78));

  // Expand rounds into one flat target list (round-robin keeps load even).
  const batch = [];
  for (let r = 0; r < ROUNDS; r++) for (const t of targets) batch.push(t);

  const doMode = async (mode, fn) => {
    console.log(`\n[${mode.toUpperCase()}] scraping ${batch.length} URLs @ concurrency ${CONCURRENCY}...`);
    const t0 = Date.now();
    const results = await runWithConcurrency(batch, CONCURRENCY, async (t, i) => {
      const r = await fn(t.url, t.selector);
      const tag = r.looksReal ? 'OK ' : (r.is400 ? '400' : 'BAD');
      console.log(
        `  [${mode[0]}${String(i + 1).padStart(3, '0')}] ${tag} ` +
        `d=${String(r.decodoStatus).padStart(3)} t=${String(r.targetStatus ?? '-').padStart(3)} ` +
        `${fmtBytes(r.size).padStart(8)} ${String(r.elapsedMs).padStart(6)}ms ` +
        `${t.kind === 'category' ? 'CAT ' : '    '}${r.error ? 'ERR:' + r.error.slice(0, 50) : ''}`,
      );
      return r;
    });
    console.log(`[${mode.toUpperCase()}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return results;
  };

  const rows = [];
  let syncResults = null, asyncResults = null;
  if (MODES === 'sync' || MODES === 'both') {
    syncResults = await doMode('sync', scrapeSync);
    rows.push(summarize('SYNC', syncResults));
  }
  if (MODES === 'async' || MODES === 'both') {
    asyncResults = await doMode('async', scrapeAsync);
    rows.push(summarize('ASYNC', asyncResults));
  }

  printSummaryTable(rows);

  // Verdict focused on the 400 question.
  if (syncResults && asyncResults) {
    const s = summarize('SYNC', syncResults);
    const a = summarize('ASYNC', asyncResults);
    console.log('\nVERDICT (the 400 question):');
    if (s.c400 === 0 && a.c400 === 0) {
      console.log('  Neither mode produced a 400 right now — the transient burst did NOT');
      console.log('  reproduce, so this run is INCONCLUSIVE about whether async fixes it.');
      console.log('  Re-run with higher AB_ROUNDS/AB_CONCURRENCY, or during a real burst.');
    } else if (s.c400 > 0 && a.c400 === 0) {
      console.log(`  SYNC hit ${s.c400} × 400 but ASYNC hit 0 → async DID avoid the transient.`);
      console.log('  Strong signal to migrate MlScraperService to the /v3/task flow.');
    } else if (a.c400 >= s.c400 && a.c400 > 0) {
      console.log(`  ASYNC hit ${a.c400} × 400 (>= sync ${s.c400}) → async does NOT fix it.`);
      console.log('  Look elsewhere (lower concurrency / lighter browser_actions).');
    } else {
      console.log(`  Mixed: sync 400=${s.c400}, async 400=${a.c400}. Re-run with more volume.`);
    }
    console.log(`  Success rate: sync ${s.okPct.toFixed(1)}% vs async ${a.okPct.toFixed(1)}%.`);
    console.log(`  Latency (median): sync ${s.median}ms vs async ${a.median}ms.`);
  }
  console.log(`\nRaw first-response dumps (for shape verification): ${path.relative(process.cwd(), DUMP_DIR)}/`);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
