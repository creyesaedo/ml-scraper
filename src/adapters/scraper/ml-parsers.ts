import * as cheerio from 'cheerio';

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
  seller_ml_id: null,
  seller_nickname: null,
  seller_is_official_store: false,
  seller_power_status: null,
  seller_total_products: null,
  seller_total_sales: null,
};

export const SITE_DOMAINS: Record<string, string> = {
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

// 2-letter geo code used by Decodo's `geo` parameter, derived from siteId.
export const SITE_GEO: Record<string, string> = {
  MLA: 'ar',
  MLB: 'br',
  MLM: 'mx',
  MLC: 'cl',
  MCO: 'co',
  MLU: 'uy',
  MLP: 'pe',
  MLV: 've',
  MLD: 'do',
  MLE: 'ec',
};

export function categoryUrl(siteId: string, categoryMlId: string): string {
  const domain = SITE_DOMAINS[siteId] ?? 'mercadolibre.com.ar';
  return `https://www.${domain}/mas-vendidos/${categoryMlId}`;
}

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
      const catalogMatch = href.match(/\/p\/(ML[A-Z][0-9]+)/);

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

export function parseProductPageHtml(html: string): ProductEnrichment {
  let sold_count: number | null = null;
  const soldMatch = html.match(/\+([\d.,]+)\s*(mil(?:l[oó]n)?)?\s*vendidos/i);
  if (soldMatch) {
    const raw = parseFloat(soldMatch[1].replace(/\./g, '').replace(',', '.'));
    const suffix = (soldMatch[2] ?? '').toLowerCase();
    if (suffix.startsWith('mill')) sold_count = Math.round(raw * 1_000_000);
    else if (suffix === 'mil') sold_count = Math.round(raw * 1_000);
    else sold_count = Math.round(raw);
  }

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
  const catalogPidMatch = html.match(/"catalogProductId"\s*:\s*"(ML[A-Z][0-9]+)"/);
  if (catalogPidMatch) catalog_product_id_from_page = catalogPidMatch[1];

  let leaf_category_id: string | null = null;
  const categoryIdMatch = html.match(/"categoryId"\s*:\s*"(ML[A-Z][0-9]+)"/);
  if (categoryIdMatch) leaf_category_id = categoryIdMatch[1];

  // ML's per-listing "item ID" shown on the product page as "Publicación #NNNNNN".
  // Distinct from catalog_id (catalog product) — this identifies the specific listing.
  let ml_public_id: string | null = null;
  const publicIdMatch = html.match(/Publicaci[oó]n\s*#\s*(\d{6,})/i);
  if (publicIdMatch) {
    ml_public_id = publicIdMatch[1];
  } else {
    const itemIdMatch = html.match(/"item_id"\s*:\s*"ML[A-Z]?(\d{6,})"/);
    if (itemIdMatch) ml_public_id = itemIdMatch[1];
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
  } else if (/"shipping"\s*:\s*\{[^{}]*"text"\s*:\s*"Env[ií]o gratis"/.test(html)) {
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
    ...seller,
  };
}

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
  else if (/Tienda oficial/i.test(html)) seller_is_official_store = true;

  let seller_power_status: string | null = null;
  const powerJsonMatch = html.match(/"power_seller_status"\s*:\s*"([^"]+)"/);
  if (powerJsonMatch) {
    seller_power_status = powerJsonMatch[1].toLowerCase();
  } else {
    const textMatch = html.match(/MercadoL[ií]der\s+(Platinum|Gold|Silver)/i);
    if (textMatch) seller_power_status = textMatch[1].toLowerCase();
    else if (/MercadoL[ií]der/i.test(html)) seller_power_status = 'mercadolider';
  }

  let seller_total_products: number | null = null;
  const productsMatch = html.match(/\+?\s*([\d.,]+)\s*([Pp]roductos?)/);
  if (productsMatch) {
    const n = parseFloat(productsMatch[1].replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(n)) seller_total_products = Math.round(n);
  }

  let seller_total_sales: number | null = null;
  const salesMatch = html.match(/\+?\s*([\d.,]+)\s*(mil(?:l[oó]n)?)?\s*[Vv]entas/);
  if (salesMatch) {
    const raw = parseFloat(salesMatch[1].replace(/\./g, '').replace(',', '.'));
    const suffix = (salesMatch[2] ?? '').toLowerCase();
    if (Number.isFinite(raw)) {
      if (suffix.startsWith('mill')) seller_total_sales = Math.round(raw * 1_000_000);
      else if (suffix === 'mil') seller_total_sales = Math.round(raw * 1_000);
      else seller_total_sales = Math.round(raw);
    }
  }

  return {
    seller_ml_id,
    seller_nickname,
    seller_is_official_store,
    seller_power_status,
    seller_total_products,
    seller_total_sales,
  };
}
