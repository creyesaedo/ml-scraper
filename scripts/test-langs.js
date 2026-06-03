/**
 * Cross-language parser check. For each scraped site (Core 8 minus MLV; never
 * MLD/MLV — those run a different page layout), scrapes 1 best-sellers category
 * + the first product PDP, runs the REAL compiled parsers, and reports which
 * fields extracted vs came back null — with focus on the language-sensitive
 * (text-based) fields that could break on Portuguese (MLB) or regional Spanish.
 *
 * Saves each PDP HTML to tmp/lang-test/<site>.html so a MISSING field can be
 * diagnosed against the real markup.
 *
 * Run:  node scripts/test-langs.js
 */
require('dotenv/config');
const fs = require('fs');
const path = require('path');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../dist/generated/prisma/client.js');
const {
  parseCategoryHtml,
  parseProductPageHtml,
  categoryUrl,
  SITE_GEO,
} = require('../dist/adapters/scraper/ml-parsers.js');

const ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';
const TOKEN = process.env.DECODO_API_TOKEN;
const SITES = ['MLA', 'MLB', 'MLC', 'MLM', 'MCO', 'MPE', 'MLU'];
const SITE_LANG = { MLA: 'es-AR', MLB: 'pt-BR', MLC: 'es-CL', MLM: 'es-MX', MCO: 'es-CO', MPE: 'es-PE', MLU: 'es-UY' };
const DUMP_DIR = path.join(__dirname, '..', 'tmp', 'lang-test');

if (!TOKEN) { console.error('ERROR: DECODO_API_TOKEN not set'); process.exit(1); }

async function scrapeOne(url, geo, waitSelector) {
  const body = {
    url, proxy_pool: 'premium', headless: 'html', geo,
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
  return { content: json.results?.[0]?.content || '', target: json.results?.[0]?.status_code };
}

async function pickCategory(prisma, site) {
  const terms = ['Celular', 'Computa', 'Electr', 'Eletr', 'Telefon', 'Inform'];
  const pref = await prisma.category.findFirst({
    where: { country: site, parent_id: null, OR: terms.map((t) => ({ name: { contains: t, mode: 'insensitive' } })) },
    select: { ml_id: true, name: true },
  });
  if (pref) return pref;
  return prisma.category.findFirst({ where: { country: site, parent_id: null }, select: { ml_id: true, name: true } });
}

// Fields grouped by sensitivity. Language-sensitive ones are the real test.
const LANG_SENSITIVE = ['sold_count', 'shipping_type', 'brand', 'seller_total_products', 'seller_total_sales', 'seller_power_status', 'seller_is_official_store'];
const LANG_AGNOSTIC = ['rating', 'review_count', 'original_price', 'discount_pct', 'listing_type_id', 'available_quantity', 'installments_quantity', 'installments_amount', 'installments_interest_free', 'catalog_product_id_from_page', 'leaf_category_id', 'seller_ml_id', 'seller_nickname'];

function fmt(v) {
  if (v === null || v === undefined) return 'NULL';
  if (v === false) return 'false';
  return String(v);
}

(async () => {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

  const results = await Promise.all(SITES.map(async (site) => {
    const cat = await pickCategory(prisma, site);
    const geo = SITE_GEO[site];
    const catUrl = categoryUrl(site, cat.ml_id);
    const catRes = await scrapeOne(catUrl, geo, 'li.ui-search-layout__item');
    const products = parseCategoryHtml(catRes.content);
    let enr = null, pdpUrl = null, pdpSize = 0, pdpTarget = null;
    if (products.length && products[0].product_url) {
      pdpUrl = products[0].product_url;
      const pdpRes = await scrapeOne(pdpUrl, geo, '.ui-pdp-price');
      pdpTarget = pdpRes.target;
      pdpSize = pdpRes.content.length;
      enr = parseProductPageHtml(pdpRes.content);
      fs.writeFileSync(path.join(DUMP_DIR, `${site}.html`), pdpRes.content);
    }
    return { site, cat, catUrl, catSize: catRes.content.length, catTarget: catRes.target, productCount: products.length, sampleName: products[0]?.name, sampleProductPrice: products[0]?.price, pdpUrl, pdpSize, pdpTarget, enr };
  }));

  await prisma.$disconnect();

  for (const r of results) {
    console.log('\n' + '='.repeat(78));
    console.log(`${r.site} (${SITE_LANG[r.site]})  cat=${r.cat.ml_id} "${r.cat.name}"`);
    console.log(`  category page: target=${r.catTarget} size=${(r.catSize/1024).toFixed(0)}KB → ${r.productCount} products`);
    console.log(`  sample: "${(r.sampleName||'').slice(0,50)}" price=${r.sampleProductPrice}`);
    if (!r.enr) { console.log('  !! no PDP scraped (0 products or no url)'); continue; }
    console.log(`  PDP: target=${r.pdpTarget} size=${(r.pdpSize/1024).toFixed(0)}KB`);
    console.log('  --- LANGUAGE-SENSITIVE fields ---');
    for (const f of LANG_SENSITIVE) console.log(`    ${f.padEnd(24)} ${fmt(r.enr[f])}`);
    console.log('  --- language-agnostic fields ---');
    for (const f of LANG_AGNOSTIC) console.log(`    ${f.padEnd(24)} ${fmt(r.enr[f])}`);
  }

  // Compact matrix of the language-sensitive fields across sites.
  console.log('\n' + '='.repeat(78));
  console.log('LANGUAGE-SENSITIVE MATRIX (✓ = extracted, · = null/false)');
  console.log('  field'.padEnd(26) + SITES.map((s) => s.padEnd(6)).join(''));
  for (const f of LANG_SENSITIVE) {
    const row = results.map((r) => {
      const v = r.enr ? r.enr[f] : null;
      const ok = v !== null && v !== undefined && v !== false;
      return (ok ? '✓' : '·').padEnd(6);
    });
    console.log(('  ' + f).padEnd(26) + row.join(''));
  }
  console.log('='.repeat(78));
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
