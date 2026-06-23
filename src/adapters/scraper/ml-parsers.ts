import * as cheerio from 'cheerio';

// Magnitude word shared by "vendidos"/"ventas"/"vendas" badges, covering both
// Spanish ("mil", "millón", "millones") and Portuguese ("mil", "milhão",
// "milhões"). Used as a sub-pattern inside larger regexes (no flags/anchors).
const MAGNITUDE = '(mil(?:l[oó]n(?:es)?|h[ãa]o|h[õo]es)?)?';

/**
 * Parses an abbreviated count badge into a plain integer, supporting both
 * Spanish and Portuguese magnitude words: "1.234", "5 mil", "2 millones" (es),
 * "2 milhões" (pt). `numRaw` is the leading number — ML uses "." as the
 * thousands separator and "," as the decimal — and `suffix` is the captured
 * magnitude word (may be undefined). Returns null when the number is unparseable.
 */
function parseMagnitudeCount(numRaw: string, suffix: string | undefined): number | null {
  const base = parseFloat(numRaw.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(base)) return null;
  const s = (suffix ?? '').toLowerCase();
  if (/^mil[lh]/.test(s)) return Math.round(base * 1_000_000); // millón/millones/milhão/milhões
  if (/^mil/.test(s)) return Math.round(base * 1_000); // mil (thousand, both languages)
  return Math.round(base);
}

export interface ScrapedProduct {
  name: string;
  price: string;
  catalog_id: string | null;
  product_url: string | null;
  ranking_position: number;
}

export type ShippingType = 'full' | 'cross_border' | 'free' | 'standard';

export interface ProductEnrichment {
  sold_count: number | null;
  rating: number | null;
  review_count: number | null;
  brand: string | null;
  date_created_from_page: string | null;
  catalog_product_id_from_page: string | null;
  ml_public_id: string | null;
  leaf_category_id: string | null;
  original_price: number | null;
  discount_pct: number | null;
  shipping_type: ShippingType | null;
  listing_type_id: string | null;
  is_cbt: boolean;
  available_quantity: number | null;
  installments_quantity: number | null;
  installments_amount: number | null;
  installments_interest_free: boolean | null;
  seller_ml_id: string | null;
  seller_nickname: string | null;
  seller_is_official_store: boolean;
  seller_power_status: string | null;
  seller_total_products: number | null;
  seller_total_sales: number | null;
}

export const EMPTY_ENRICHMENT: ProductEnrichment = {
  sold_count: null,
  rating: null,
  review_count: null,
  brand: null,
  date_created_from_page: null,
  catalog_product_id_from_page: null,
  ml_public_id: null,
  leaf_category_id: null,
  original_price: null,
  discount_pct: null,
  shipping_type: null,
  listing_type_id: null,
  is_cbt: false,
  available_quantity: null,
  installments_quantity: null,
  installments_amount: null,
  installments_interest_free: null,
  seller_ml_id: null,
  seller_nickname: null,
  seller_is_official_store: false,
  seller_power_status: null,
  seller_total_products: null,
  seller_total_sales: null,
};

export const SITE_DOMAINS: Record<string, string> = {
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

// ISO 4217 currency code per MercadoLibre site. Used to convert the local
// price to USD at scrape time. MLE (Ecuador) already trades in USD.
export const SITE_CURRENCIES: Record<string, string> = {
  MLA: 'ARS', // Argentina
  MLB: 'BRL', // Brazil
  MLM: 'MXN', // Mexico
  MLC: 'CLP', // Chile
  MCO: 'COP', // Colombia
  MLU: 'UYU', // Uruguay
  MPE: 'PEN', // Peru
  MLV: 'VES', // Venezuela
  MLD: 'DOP', // Dominican Republic
  MLE: 'USD', // Ecuador — already USD
};

/** Returns the ISO 4217 currency for a site, or null when the site is unknown. */
export function currencyForSite(siteId: string): string | null {
  return SITE_CURRENCIES[siteId] ?? null;
}

/**
 * Infers the siteId (e.g. "MLC") from a MercadoLibre product/category URL by
 * matching its domain against SITE_DOMAINS. Returns null for unknown domains so
 * the caller can require an explicit siteId. Used by the single-product worker
 * endpoint, where only a URL is supplied.
 */
export function siteIdFromUrl(url: string): string | null {
  for (const [site, domain] of Object.entries(SITE_DOMAINS)) {
    if (url.includes(domain)) return site;
  }
  return null;
}

// 2-letter geo code used by Decodo's `geo` parameter, derived from siteId.
export const SITE_GEO: Record<string, string> = {
  MLA: 'ar',
  MLB: 'br',
  MLM: 'mx',
  MLC: 'cl',
  MCO: 'co',
  MLU: 'uy',
  MPE: 'pe',
  MLV: 've',
  MLD: 'do',
  MLE: 'ec',
};

// URL slug for the "best sellers" section, per site. Spanish sites use
// "mas-vendidos"; Brazil (Portuguese) uses "mais-vendidos". Verified live:
// mercadolivre.com.br/mas-vendidos → 404, /mais-vendidos → 200. Sites not listed
// fall back to the Spanish slug.
const SITE_BESTSELLER_SLUG: Record<string, string> = {
  MLB: 'mais-vendidos',
};
const DEFAULT_BESTSELLER_SLUG = 'mas-vendidos';

// Sites where MercadoLibre runs a reduced/classifieds-only marketplace with NO
// best-sellers section at all — every /mas-vendidos[/...] path 404s regardless of
// language or category. Verified live (2026-05-30): the homepage returns 200 but
// /mas-vendidos, /mais-vendidos and /mas-vendidos/{cat} all 404. Scraping these
// only burns billed category requests for 0 products, so callers skip them.
//   - MLD (Dominican Republic): no best-sellers, no /ofertas either.
//   - MLV (Venezuela): best-sellers hub 200 but every per-category page 404s.
export const SITES_WITHOUT_BESTSELLERS = new Set<string>(['MLD', 'MLV']);

/** True if the site has a best-sellers section worth scraping (see SITES_WITHOUT_BESTSELLERS). */
export function siteHasBestSellers(siteId: string): boolean {
  return !SITES_WITHOUT_BESTSELLERS.has(siteId);
}

/**
 * Builds the best-sellers page URL for a category, picking the right domain and
 * language slug per site (e.g. ".cl/mas-vendidos/..." vs ".com.br/mais-vendidos/...").
 * Unknown sites fall back to the Argentine domain and the Spanish slug.
 */
export function categoryUrl(siteId: string, categoryMlId: string): string {
  const domain = SITE_DOMAINS[siteId] ?? 'mercadolibre.com.ar';
  const slug = SITE_BESTSELLER_SLUG[siteId] ?? DEFAULT_BESTSELLER_SLUG;
  return `https://www.${domain}/${slug}/${categoryMlId}`;
}

/**
 * Parses a best-sellers category page into a list of products. Each list item
 * yields a name, price (digits only), the catalog id pulled from the link (if
 * the listing has a catalog page), the product URL, and a 1-based ranking
 * position. Items without a name are skipped. Returns an empty array on any
 * parse error so the caller can treat it as "no products" rather than crash.
 */
export function parseCategoryHtml(html: string): ScrapedProduct[] {
  try {
    const $ = cheerio.load(html);
    const products: ScrapedProduct[] = [];

    $('li.ui-search-layout__item').each((_i, el) => {
      const name = $(el).find('.poly-component__title').text().trim();
      const priceRaw = $(el)
        .find('.andes-money-amount__fraction')
        .first()
        .text()
        .trim()
        .replace(/\./g, '');

      const href = $(el).find('a.poly-component__title').attr('href') ?? '';
      const catalogMatch = href.match(/\/p\/(M[A-Z]{2}[0-9]+)/);

      if (name) {
        products.push({
          name,
          price: priceRaw || '0',
          catalog_id: catalogMatch?.[1] ?? null,
          product_url: href ? href.split('#')[0] : null,
          ranking_position: products.length + 1,
        });
      }
    });

    return products;
  } catch {
    return [];
  }
}

/**
 * Extracts the basic name + price from a product page (the two fields the
 * category listing normally supplies). Used by the single-product worker
 * endpoint, where there is no category listing to read them from. Price is
 * returned as digits only (matching parseCategoryHtml). Returns nulls on any
 * parse error so the caller still gets the enrichment.
 */
export function parseProductBasicsFromHtml(html: string): {
  name: string | null;
  price: string | null;
} {
  try {
    const $ = cheerio.load(html);
    const name = $('h1.ui-pdp-title').first().text().trim() || null;
    const price =
      $('.andes-money-amount__fraction').first().text().trim().replace(/\./g, '') || null;
    return { name, price };
  } catch {
    return { name: null, price: null };
  }
}

/**
 * Extracts enrichment fields from a single product page's raw HTML.
 *
 * MercadoLibre embeds most of this data as JSON inside inline <script> tags, so
 * the function scans the HTML with targeted regexes rather than a DOM parser:
 * units sold (decoding "+X mil/millón vendidos"), rating and review count,
 * brand, listing dates and ids, price/discount, shipping type, and the seller
 * block. Every field is optional — anything not found stays null. This never
 * throws; missing data simply produces a sparser ProductEnrichment.
 */
export function parseProductPageHtml(html: string): ProductEnrichment {
  // "vendidos" is identical in es and pt; only the magnitude word differs
  // (es "mil/millón/millones", pt "mil/milhão/milhões"), handled by MAGNITUDE.
  let sold_count: number | null = null;
  const soldMatch = html.match(new RegExp(`\\+([\\d.,]+)\\s*${MAGNITUDE}?\\s*vendidos`, 'i'));
  if (soldMatch) sold_count = parseMagnitudeCount(soldMatch[1], soldMatch[2]);

  let rating: number | null = null;
  let review_count: number | null = null;
  const reviewsMatch = html.match(
    /"reviews"\s*:\s*\{"rating"\s*:\s*([\d.]+)\s*,\s*"amount"\s*:\s*(\d+)/,
  );
  if (reviewsMatch) {
    rating = parseFloat(reviewsMatch[1]);
    review_count = parseInt(reviewsMatch[2], 10);
  }

  let brand: string | null = null;
  const brandMatch = html.match(/"id"\s*:\s*"Marca"\s*,\s*"text"\s*:\s*"([^"]+)"/);
  if (brandMatch) brand = brandMatch[1];

  let date_created_from_page: string | null = null;
  const dateMatch = html.match(/"date_created"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/);
  if (dateMatch) date_created_from_page = dateMatch[1];

  let catalog_product_id_from_page: string | null = null;
  const catalogPidMatch = html.match(/"catalogProductId"\s*:\s*"(M[A-Z]{2}[0-9]+)"/);
  if (catalogPidMatch) catalog_product_id_from_page = catalogPidMatch[1];

  let leaf_category_id: string | null = null;
  const categoryIdMatch = html.match(/"categoryId"\s*:\s*"(M[A-Z]{2}[0-9]+)"/);
  if (categoryIdMatch) leaf_category_id = categoryIdMatch[1];

  // ML's per-listing "item ID" (the ml_public_id), distinct from catalog_id (the
  // catalog product). Tried most-reliable first: the embedded `item_id` JSON and
  // the app deep-link (`meli://item?id=...`) both sit near the top of the HTML and
  // survive even when the visible "Publicación #NNN" footer is a non-interpolated
  // template (`Publicación {item_id_number}`, common on catalog /p/ pages). The
  // visible text is the last resort. Captured as digits only (site prefix dropped)
  // to match how the rest of the pipeline stores it.
  let ml_public_id: string | null = null;
  for (const re of [
    /"item_id"\s*:\s*"M[A-Z]{2}(\d{6,})"/,
    /meli:\/\/item\?id=M[A-Z]{2}(\d{6,})/,
    /Publicaci[oó]n\s*#\s*(\d{6,})/i,
  ]) {
    const m = html.match(re);
    if (m) {
      ml_public_id = m[1];
      break;
    }
  }

  // Original price (previous_price.value just before current_price.value in the
  // buy-box price block). Captured as a raw number — caller stores as decimal.
  let original_price: number | null = null;
  const previousPriceMatch = html.match(
    /"previous_price"\s*:\s*\{\s*"value"\s*:\s*([\d.]+)/,
  );
  if (previousPriceMatch) {
    const n = parseFloat(previousPriceMatch[1]);
    if (Number.isFinite(n)) original_price = n;
  }

  // Discount percentage shown on the buy-box ("discount":{"value":34}).
  let discount_pct: number | null = null;
  const discountMatch = html.match(/"discount"\s*:\s*\{\s*"value"\s*:\s*(\d{1,3})\s*\}/);
  if (discountMatch) {
    const n = parseInt(discountMatch[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 100) discount_pct = n;
  }

  // Shipping type — derived from the icon shown in the buy-box "shipping" block.
  // Priority: full > cross_border > free > standard.
  let shipping_type: ShippingType | null = null;
  if (/"icon_id"\s*:\s*"vpp_full_icon"/.test(html)) {
    shipping_type = 'full';
  } else if (/cbt_fsbar_airplane|"icon_id"\s*:\s*"cbt[^"]*"/.test(html)) {
    shipping_type = 'cross_border';
  } else if (
    /"shipping"\s*:\s*\{[^{}]*"text"\s*:\s*"(?:Env[ií]o gratis|Frete gr[áa]tis)"/.test(html)
  ) {
    // es "Envío gratis" / pt "Frete grátis".
    shipping_type = 'free';
  } else if (/"shipping"\s*:\s*\{[^{}]*"text"\s*:/.test(html)) {
    shipping_type = 'standard';
  }

  // Listing tier sold by ML to the seller (gold_pro, gold_special, etc.).
  let listing_type_id: string | null = null;
  const listingTypeMatch = html.match(/"listing_type_id"\s*:\s*"([a-z_]+)"/);
  if (listingTypeMatch) listing_type_id = listingTypeMatch[1];

  // Cross-border (international) listing. ML renders the cbt_summary block
  // and/or the airplane icon only when the winning offer is international.
  const is_cbt = /"cbt_summary"|cbt_fsbar_airplane/.test(html);

  // Seller-declared stock. ML exposes it in the quantity selector as
  // "available_quantity":N (the component-list entries that share the name are
  // objects/strings, so requiring a digit isolates the numeric value). ML caps
  // the dropdown display, so this is a floor for high-stock listings.
  let available_quantity: number | null = null;
  const stockMatch = html.match(/"available_quantity"\s*:\s*(\d+)/);
  if (stockMatch) {
    const n = parseInt(stockMatch[1], 10);
    if (Number.isFinite(n)) available_quantity = n;
  }

  // Installments (financing). ML's pricing block exposes the count as
  // "installments_amount", the per-payment value as "installments_value_each",
  // and the interest-free flag as "is_free_installments".
  let installments_quantity: number | null = null;
  const instCountMatch = html.match(/"installments_amount"\s*:\s*(\d+)/);
  if (instCountMatch) {
    const n = parseInt(instCountMatch[1], 10);
    if (Number.isFinite(n) && n > 0) installments_quantity = n;
  }

  let installments_amount: number | null = null;
  const instValueMatch = html.match(/"installments_value_each"\s*:\s*([\d.]+)/);
  if (instValueMatch) {
    const n = parseFloat(instValueMatch[1]);
    if (Number.isFinite(n) && n > 0) installments_amount = n;
  }

  // Nullable on purpose: "unknown" (no installments block) must stay distinct
  // from "has installments, with interest".
  let installments_interest_free: boolean | null = null;
  const interestMatch = html.match(/"is_free_installments"\s*:\s*(true|false)/);
  if (interestMatch) installments_interest_free = interestMatch[1] === 'true';

  const seller = parseSellerFromHtml(html);

  return {
    sold_count,
    rating,
    review_count,
    brand,
    date_created_from_page,
    catalog_product_id_from_page,
    ml_public_id,
    leaf_category_id,
    original_price,
    discount_pct,
    shipping_type,
    listing_type_id,
    is_cbt,
    available_quantity,
    installments_quantity,
    installments_amount,
    installments_interest_free,
    ...seller,
  };
}

/**
 * Extracts the seller profile from a product page. ML renders seller data in
 * several different shapes (plain JSON, escaped JSON, or visible text) depending
 * on the page variant, so each field tries a list of patterns and keeps the
 * first match. Count fields ("X mil ventas", "X productos") are normalized into
 * plain integers. Fields with no match are left null / false.
 */
function parseSellerFromHtml(html: string): {
  seller_ml_id: string | null;
  seller_nickname: string | null;
  seller_is_official_store: boolean;
  seller_power_status: string | null;
  seller_total_products: number | null;
  seller_total_sales: number | null;
} {
  let seller_ml_id: string | null = null;
  const sellerIdPatterns = [
    /"seller_id"\s*:\s*(\d{4,})/,
    /"seller"\s*:\s*\{[^}]*?"id"\s*:\s*(\d{4,})/,
    /_CustId_(\d{4,})/,
    /[?&]seller_id=(\d{4,})/,
  ];
  for (const re of sellerIdPatterns) {
    const m = html.match(re);
    if (m) {
      seller_ml_id = m[1];
      break;
    }
  }

  let seller_nickname: string | null = null;
  const nicknamePatterns = [
    /"nickname"\s*:\s*"([^"]+)"/,
    /\\"nickname\\"\s*:\s*\\"([^"\\]+)\\"/,
    /"sellerName"\s*:\s*"([^"]+)"/,
    /"seller_name"\s*:\s*"([^"]+)"/,
    /Vendido por[^<]*<[^>]*>([^<]{2,})</i,
    /data-testid="seller-name"[^>]*>([^<]+)/i,
  ];
  for (const re of nicknamePatterns) {
    const m = html.match(re);
    if (m && m[1].trim()) {
      seller_nickname = m[1].trim();
      break;
    }
  }

  let seller_is_official_store = false;
  const officialIdMatch = html.match(/"official_store_id"\s*:\s*(\d+)/);
  if (officialIdMatch) seller_is_official_store = true;
  else if (/Tienda oficial|Loja oficial/i.test(html)) seller_is_official_store = true; // es / pt

  let seller_power_status: string | null = null;
  const powerJsonMatch = html.match(/"power_seller_status"\s*:\s*"([^"]+)"/);
  if (powerJsonMatch) {
    seller_power_status = powerJsonMatch[1].toLowerCase();
  } else {
    const textMatch = html.match(/MercadoL[ií]der\s+(Platinum|Gold|Silver)/i);
    if (textMatch) seller_power_status = textMatch[1].toLowerCase();
    else if (/MercadoL[ií]der/i.test(html)) seller_power_status = 'mercadolider';
  }

  // es "producto(s)" / pt "produto(s)" — the optional "c" covers both.
  let seller_total_products: number | null = null;
  const productsMatch = html.match(/\+?\s*([\d.,]+)\s*produc?tos?\b/i);
  if (productsMatch) {
    const n = parseFloat(productsMatch[1].replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(n)) seller_total_products = Math.round(n);
  }

  // es "ventas" / pt "vendas", each optionally prefixed by a magnitude word.
  let seller_total_sales: number | null = null;
  const salesMatch = html.match(new RegExp(`\\+?\\s*([\\d.,]+)\\s*${MAGNITUDE}?\\s*(?:ventas?|vendas?)`, 'i'));
  if (salesMatch) seller_total_sales = parseMagnitudeCount(salesMatch[1], salesMatch[2]);

  return {
    seller_ml_id,
    seller_nickname,
    seller_is_official_store,
    seller_power_status,
    seller_total_products,
    seller_total_sales,
  };
}
