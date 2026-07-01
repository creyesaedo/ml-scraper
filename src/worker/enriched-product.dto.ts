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
/** Per-star review breakdown from the ML API (`/reviews/item` `rating_levels`). */
export interface ReviewLevels {
  one_star: number;
  two_star: number;
  three_star: number;
  four_star: number;
  five_star: number;
}

export interface EnrichedProduct {
  // Listing basics (from the category page; name/price may be null for the
  // single-product endpoint where there is no listing).
  name: string;
  price: string;
  product_url: string | null;
  // 1-based position within a category's best-sellers list. `null` = no ranking
  // context (single-product scrape, or a product not in any best-sellers list).
  // NEVER 0 — 0 is not a valid rank and would sort as "better than #1".
  ranking_position: number | null;

  // Catalog / listing identity.
  catalog_id: string | null;
  ml_public_id: string | null;
  date_created: string | null; // ISO 8601, from ML API or the page

  // Product-page enrichment.
  sold_count: number | null;
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

  // Demand signals from the ML official API (NOT scraped). Keyed by the listing
  // id (siteId + ml_public_id). Reviews come from `/reviews/item/{id}` (replaces
  // the old page-scraped rating/review_count), visits from
  // `/items/{id}/visits/time_window?last=1&unit=week`. All null when there is no
  // ml_public_id or the API call fails.
  rating: number | null; // rating_average (0 when no reviews)
  review_count: number | null; // per-listing total — 0 = no reviews, null = fetch failed
  review_levels: ReviewLevels | null; // per-star breakdown (all-zero when no reviews)
  weekly_visits: number | null; // visits in the trailing 7 days

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

/**
 * Phase 1 output (Decodo + page parse + FX + holiday — NO ML API calls). This is
 * what the worker returns from `/scrape/category/.../raw` and ml-service stores in
 * `staging_products`. `date_created_from_page` is a hint; the final `date_created`
 * is resolved by the ML API in phase 2. `ml_public_id` here is the page-parsed one
 * (may be null; phase 2 can recover it from the catalog buy-box winner).
 */
export interface RawScrapedProduct {
  name: string;
  price: string;
  product_url: string | null;
  ranking_position: number | null;
  catalog_id: string | null;
  ml_public_id: string | null;
  date_created_from_page: string | null;
  sold_count: number | null;
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
  currency: string | null;
  exchange_rate: number | null;
  usd_price: number | null;
  usd_original_price: number | null;
  holiday_name: string | null;
  leaf_category_ml_id: string | null;
  seller_ml_id: string | null;
  seller_nickname: string | null;
  seller_is_official_store: boolean;
  seller_power_status: string | null;
  seller_total_products: number | null;
  seller_total_sales: number | null;
}

/**
 * Phase 2 input: the identifiers the ML-API enrichment step needs for one product.
 * ml-service builds these from the staged `RawScrapedProduct`s and posts them to
 * `/enrich`.
 */
export interface EnrichInput {
  site_id: string;
  catalog_id: string | null;
  ml_public_id: string | null;
  product_url: string | null;
  leaf_category_ml_id: string | null;
  date_created_from_page: string | null;
}

/**
 * Phase 2 output: the ML-API-derived fields for one product, returned in the same
 * order as the `EnrichInput[]` posted. ml-service merges this onto the staged
 * `RawScrapedProduct` to form the final `EnrichedProduct` before persisting.
 * `ml_public_id` may be recovered from the catalog buy-box winner when the page
 * didn't yield one. Reviews/visits: `0`/all-zero = no data, `null` = fetch failed.
 */
export interface EnrichResult {
  ml_public_id: string | null;
  date_created: string | null;
  leaf_category_name: string | null;
  rating: number | null;
  review_count: number | null;
  review_levels: ReviewLevels | null;
  weekly_visits: number | null;
}

/** Verdict of the best-sellers probe (mirrors MlScraperService). */
export type ProbeVerdict = 'has_products' | 'empty' | 'no_page' | 'failed';
