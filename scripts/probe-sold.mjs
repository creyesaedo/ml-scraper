#!/usr/bin/env node
// Probe whether ML embeds an EXACT sold count anywhere in the page, vs the
// rounded "+X mil vendidos" we parse today. Uses the SAME Decodo channel as
// MlScraperService (premium pool + headless + the SSR browser_actions chain),
// so we see exactly what the scraper sees — not a curl that the anti-bot blocks.
//
// Usage: node scripts/probe-sold.mjs "<ml-product-url>" [siteId]
import { readFileSync, writeFileSync } from 'node:fs';

const DECODO_ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';

// --- read DECODO_API_TOKEN straight from .env (no deps) ---
function envToken() {
  const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith('DECODO_API_TOKEN='));
  if (!line) throw new Error('DECODO_API_TOKEN not in .env');
  return line.slice('DECODO_API_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
}

const SITE_GEO = { MLA:'ar', MLB:'br', MLM:'mx', MLC:'cl', MCO:'br', MLU:'uy', MPE:'pe', MLE:'ec' };

function siteIdFromUrl(u) {
  if (u.includes('mercadolibre.cl')) return 'MLC';
  if (u.includes('mercadolibre.com.ar')) return 'MLA';
  if (u.includes('mercadolivre.com.br')) return 'MLB';
  if (u.includes('mercadolibre.com.mx')) return 'MLM';
  if (u.includes('mercadolibre.com.co')) return 'MCO';
  if (u.includes('mercadolibre.com.pe')) return 'MPE';
  return 'MLA';
}

const url = (process.argv[2] || '').split('#')[0];
if (!url) { console.error('Pasa la URL del producto'); process.exit(1); }
const siteId = process.argv[3] || siteIdFromUrl(url);

const body = {
  url,
  proxy_pool: 'premium',
  headless: 'html',
  geo: SITE_GEO[siteId] || 'ar',
  browser_actions: [
    { type: 'wait', wait_time_s: 4 },
    { type: 'scroll_to_bottom', timeout_s: 5 },
    { type: 'wait', wait_time_s: 3 },
    { type: 'wait_for_element', selector: { type: 'css', value: '.nav-footer' }, timeout_s: 15, on_error: 'skip' },
  ],
};

console.log(`Scraping vía Decodo (premium/headless, geo=${body.geo})...\n  ${url}\n`);

const res = await fetch(DECODO_ENDPOINT, {
  method: 'POST',
  headers: { Accept:'application/json', 'Content-Type':'application/json', Authorization:`Basic ${envToken()}` },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(180000),
});
if (!res.ok) { console.error(`Decodo HTTP ${res.status}: ${(await res.text()).slice(0,300)}`); process.exit(1); }
const json = await res.json();
const html = json.results?.[0]?.content ?? '';
const targetStatus = json.results?.[0]?.status_code ?? null;
console.log(`target_status=${targetStatus}  html=${html.length} bytes\n`);

const out = '/tmp/claude-1000/-home-cristian-projects/5527c161-847b-496a-93d9-47e4b0f3561a/scratchpad/pdp.html';
writeFileSync(out, html);
console.log(`HTML completo guardado en: ${out}\n`);

const uniq = (arr) => [...new Set(arr)];
const show = (label, arr) => {
  console.log(`── ${label} (${arr.length}) ──`);
  for (const m of arr.slice(0, 25)) console.log('   ' + m);
  console.log('');
};

// 1) The rounded badge we parse today.
show('Texto "vendidos" visible (lo que parseamos hoy)',
  uniq([...html.matchAll(/.{0,14}vendido[s]?/gi)].map((m) => m[0].replace(/\s+/g,' ').trim())));

// 2) Any JSON key that looks like a sold/quantity counter — and its VALUE.
//    If an exact integer exists, it shows here (e.g. "sold_quantity":10847).
show('Claves JSON sold/quantity con su valor',
  uniq([...html.matchAll(/"[a-z_]*(?:sold|sales|quantity|purchase|order)[a-z_]*"\s*:\s*("?[^",}{]{1,40})/gi)].map((m)=>m[0].trim())));

// 3) The subtitle node (Nuevo | +N vendidos) — confirm it's server-rendered text.
show('subtitle / value_name alrededor de vendidos',
  uniq([...html.matchAll(/"(?:subtitle|value_name|title|label)"\s*:\s*"[^"]*vendido[^"]*"/gi)].map((m)=>m[0].trim())));

// 4) Raw integers that appear within 60 chars BEFORE the word "vendidos"
//    (catches an exact count rendered next to the badge, if any).
show('Enteros crudos a ≤60 chars de "vendidos"',
  uniq([...html.matchAll(/(\d{3,})[^\d"]{0,60}vendido/gi)].map((m)=>m[0].replace(/\s+/g,' ').trim())));
