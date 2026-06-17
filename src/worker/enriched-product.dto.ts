/**
 * Persist-ready product DTO returned by the worker. It is the union of what the
 * old monolith assembled inside ProductCollectionService before writing a
 * snapshot row: the category-listing basics + product-page enrichment + ML API
 * `date_created` + FX conversion + holiday tag + the leaf category's ML id and
 * NAME (the worker resolves the name via the ML API so ml-service only has to
 * map it to a DB id, not make another API call).
 *
 * This file is the contract between the worker and ml-service. A copy lives in
 * `ml-service/src/adapters/scraper-client/` — keep the two in sync.
 */
export interface EnrichedProduct {
  // Listing basics (from the category page; name/price may be null for the
  // single-product endpoint where there is no listing).
  name: string;
  price: string;
  product_url: string | null;
  ranking_position: number;

  // Catalog / listing identity.
  catalog_id: string | null;
  ml_public_id: string | null;
  date_created: string | null; // ISO 8601, from ML API or the page

  // Product-page enrichment.
  sold_count: number | null;
  rating: number | null;
  review_count: number | null;
  brand: string | null;
  original_price: number | null;
  discount_pct: number | null;
  shipping_type: string | null;
  listing_type_id: string | null;
  is_cbt: boolean;
  available_quantity: number | null;
  installments_quantity: number | null;
  installments_amount: number | null;
  installments_interest_free: boolean | null;

  // FX (computed in the worker from the site's currency + USD rate).
  currency: string | null;
  exchange_rate: number | null;
  usd_price: number | null;
  usd_original_price: number | null;

  // Holiday tag for the scrape date in the site's country.
  holiday_name: string | null;

  // Leaf category: the ML id read from the page + its name resolved via the ML
  // API. ml-service upserts it into the categories table under the root.
  leaf_category_ml_id: string | null;
  leaf_category_name: string | null;

  // Seller profile (ml-service dedupes into the sellers table).
  seller_ml_id: string | null;
  seller_nickname: string | null;
  seller_is_official_store: boolean;
  seller_power_status: string | null;
  seller_total_products: number | null;
  seller_total_sales: number | null;
}

/** Verdict of the best-sellers probe (mirrors MlScraperService). */
export type ProbeVerdict = 'has_products' | 'empty' | 'no_page' | 'failed';
