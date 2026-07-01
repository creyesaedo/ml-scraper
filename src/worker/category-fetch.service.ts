import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import pLimit from 'p-limit';
import { ExchangeRateClient } from '../adapters/exchange/exchange-rate.client';
import { HolidaysClient } from '../adapters/holidays/holidays.client';
import { MercadoLibreClient } from '../adapters/mercadolibre/mercadolibre.client';
import {
  currencyForSite,
  EMPTY_ENRICHMENT,
  ProductEnrichment,
  ScrapedProduct,
  itemIdFromUrl,
  siteIdFromUrl,
  userProductIdFromUrl,
} from '../adapters/scraper/ml-parsers';
import { MlScraperService } from '../adapters/scraper/ml-scraper.service';
import { ScraperHealthService } from '../adapters/scraper/scraper-health.service';
import appConfig from '../config/app.config';
import {
  EnrichedProduct,
  EnrichInput,
  EnrichResult,
  RawScrapedProduct,
  ReviewLevels,
} from './enriched-product.dto';

/**
 * Converts a local-currency amount to USD (local units per 1 USD), rounded to 2
 * decimals. Returns null when the amount or rate is missing/unusable.
 */
function toUsd(local: number | null, rate: number | null): number | null {
  if (local == null || rate == null || !Number.isFinite(local) || rate <= 0) {
    return null;
  }
  const usd = local / rate;
  return Number.isFinite(usd) ? Math.round(usd * 100) / 100 : null;
}

/**
 * The worker-side "fetch + enrich" half of the old ProductCollectionService.
 * It scrapes a category's best-sellers (Decodo), then enriches each product via
 * the ML API (`date_created`, leaf category name), FX, and holidays, returning
 * persist-ready {@link EnrichedProduct}s. It does NOT touch a database — leaf
 * category id resolution and snapshot writes are ml-service's job.
 */
@Injectable()
export class CategoryFetchService {
  private readonly logger = new Logger(CategoryFetchService.name);

  constructor(
    private readonly scraper: MlScraperService,
    private readonly mlClient: MercadoLibreClient,
    private readonly holidays: HolidaysClient,
    private readonly exchangeRates: ExchangeRateClient,
    private readonly health: ScraperHealthService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  /**
   * Scrapes a category's best-sellers and returns every product fully enriched.
   * The circuit breaker is reset on entry so each category fetch is an
   * independent unit. Run-level aborts (circuit breaker / Decodo account error)
   * propagate to the caller.
   */
  async fetchEnrichedCategory(
    siteId: string,
    categoryMlId: string,
  ): Promise<EnrichedProduct[]> {
    const raws = await this.fetchRawCategory(siteId, categoryMlId);
    if (!raws.length) return [];
    const results = await this.enrichProducts(raws.map((r) => toEnrichInput(siteId, r)));
    return raws.map((r, i) => mergeEnriched(r, results[i]));
  }

  /**
   * PHASE 1 (Decodo only, no ML API). Scrapes a category's best-sellers and
   * returns each product with everything obtainable WITHOUT the ML API: page
   * fields + FX + holiday. ml-service stages these; the ML-API enrichment happens
   * later in {@link enrichProducts}, rate-limited and resumable. The circuit
   * breaker is reset on entry; run-level aborts propagate to the caller.
   */
  async fetchRawCategory(siteId: string, categoryMlId: string): Promise<RawScrapedProduct[]> {
    this.health.reset();
    const productConcurrency = this.config.productConcurrency;

    const { products, enrichmentsByUrl } = await this.scraper.scrapeCategoryWithProducts(
      siteId,
      categoryMlId,
      productConcurrency,
    );
    if (!products.length) return [];

    const snapshotDate = new Date();
    const currency = currencyForSite(siteId);
    const exchangeRate = currency ? await this.exchangeRates.getRate(currency, snapshotDate) : null;
    const holidayName = await this.holidays.getHolidayName(snapshotDate, siteId);

    return products.map((p) => {
      const pageData = p.product_url
        ? enrichmentsByUrl.get(p.product_url) ?? EMPTY_ENRICHMENT
        : EMPTY_ENRICHMENT;
      return this.buildRaw(p, pageData, currency, exchangeRate, holidayName);
    });
  }

  /**
   * PHASE 2 (ML API, rate-limited). For each input resolves `date_created`, the
   * leaf category name, reviews and weekly visits via the ML official API, and
   * recovers `ml_public_id` from the catalog buy-box when the page missed it.
   * Returns results positionally aligned to `items`. All calls go through the
   * client's global rate limiter (≤ ML's 25 req/s), so this paces itself.
   */
  async enrichProducts(items: EnrichInput[]): Promise<EnrichResult[]> {
    const leafNameCache = new Map<string, string | null>();
    const limit = pLimit(this.config.productConcurrency);
    return Promise.all(items.map((it) => limit(() => this.enrichOne(it, leafNameCache))));
  }

  /**
   * Scrapes a single product page by URL and returns it enriched. siteId is
   * inferred from the URL domain when not supplied. Used by the "scrape one
   * product" endpoint — it does not persist anything.
   */
  async fetchProduct(url: string, siteIdHint?: string): Promise<EnrichedProduct> {
    this.health.reset();
    const siteId = siteIdHint?.toUpperCase() ?? siteIdFromUrl(url);
    if (!siteId) {
      throw new BadRequestException(
        `Could not infer siteId from URL "${url}". Pass siteId explicitly.`,
      );
    }

    const { name, price, enrichment } = await this.scraper.scrapeProductEnriched(url, siteId);
    const snapshotDate = new Date();
    const currency = currencyForSite(siteId);
    const exchangeRate = currency ? await this.exchangeRates.getRate(currency, snapshotDate) : null;
    const holidayName = await this.holidays.getHolidayName(snapshotDate, siteId);

    const scraped: ScrapedProduct = {
      name: name ?? '',
      price: price ?? '0',
      catalog_id: null,
      product_url: url,
      // No ranking context on a single-product scrape (not a best-sellers list).
      ranking_position: null,
    };
    const raw = this.buildRaw(scraped, enrichment, currency, exchangeRate, holidayName);
    const [result] = await this.enrichProducts([toEnrichInput(siteId, raw)]);
    return mergeEnriched(raw, result);
  }

  /** Resolves a leaf category's name via the ML API, cached per call. */
  private async resolveLeafName(
    leafMlId: string,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    if (cache.has(leafMlId)) return cache.get(leafMlId)!;
    const data = await this.mlClient.getCategory(leafMlId);
    const name = data?.name ?? null;
    cache.set(leafMlId, name);
    return name;
  }

  /**
   * PHASE 1 assembly: the listing/page/FX/holiday fields — everything obtainable
   * without the ML API. `ml_public_id` is the page-parsed one (no buy-box fallback
   * here; that needs the ML API and happens in {@link enrichOne}).
   */
  private buildRaw(
    p: ScrapedProduct,
    pageData: ProductEnrichment,
    currency: string | null,
    exchangeRate: number | null,
    holidayName: string | null,
  ): RawScrapedProduct {
    const effectiveCatalogId = p.catalog_id ?? pageData.catalog_product_id_from_page ?? null;
    return {
      name: p.name,
      price: p.price,
      product_url: p.product_url,
      ranking_position: p.ranking_position,
      catalog_id: effectiveCatalogId,
      ml_public_id: pageData.ml_public_id,
      date_created_from_page: pageData.date_created_from_page,
      sold_count: pageData.sold_count,
      brand: pageData.brand,
      original_price: pageData.original_price,
      discount_pct: pageData.discount_pct,
      shipping_type: pageData.shipping_type,
      listing_type_id: pageData.listing_type_id,
      is_cbt: pageData.is_cbt,
      available_quantity: pageData.available_quantity,
      installments_quantity: pageData.installments_quantity,
      installments_amount: pageData.installments_amount,
      installments_interest_free: pageData.installments_interest_free,
      currency,
      exchange_rate: exchangeRate,
      usd_price: toUsd(Number(p.price), exchangeRate),
      usd_original_price: toUsd(pageData.original_price, exchangeRate),
      holiday_name: holidayName,
      leaf_category_ml_id: pageData.leaf_category_id,
      seller_ml_id: pageData.seller_ml_id,
      seller_nickname: pageData.seller_nickname,
      seller_is_official_store: pageData.seller_is_official_store,
      seller_power_status: pageData.seller_power_status,
      seller_total_products: pageData.seller_total_products,
      seller_total_sales: pageData.seller_total_sales,
    };
  }

  /**
   * PHASE 2 for one product: resolves `date_created`, the leaf category name,
   * reviews and weekly visits via the ML API (all through the client's rate
   * limiter), and recovers `ml_public_id` from the catalog buy-box winner when the
   * page didn't yield one.
   */
  private async enrichOne(
    item: EnrichInput,
    leafNameCache: Map<string, string | null>,
  ): Promise<EnrichResult> {
    const apiData = item.catalog_id
      ? await this.mlClient.getCatalogProduct(item.catalog_id)
      : null;

    // date_created from the cheapest source first (catalog API or page); if still
    // missing and there is no catalog id, fall back by URL type:
    //   /up/ user product -> user-products API · classic -> item description.
    let date_created = apiData?.date_created ?? item.date_created_from_page ?? null;
    if (!date_created && !item.catalog_id) {
      const userProductId = userProductIdFromUrl(item.product_url);
      const itemId = itemIdFromUrl(item.product_url);
      if (userProductId) {
        date_created = (await this.mlClient.getUserProduct(userProductId))?.date_created ?? null;
      } else if (itemId) {
        date_created = (await this.mlClient.getItemDate(itemId))?.date_created ?? null;
      }
    }

    // Recover the listing id from the catalog buy-box winner when the page missed
    // it. The API returns it site-prefixed ("MCO3975198228") — strip the prefix to
    // match the page parser (digits only).
    const ml_public_id =
      item.ml_public_id ??
      (apiData?.buy_box_winner_item_id
        ? apiData.buy_box_winner_item_id.replace(/^M[A-Z]{2}/, '')
        : null);

    let leaf_category_name: string | null = null;
    if (item.leaf_category_ml_id) {
      leaf_category_name = await this.resolveLeafName(item.leaf_category_ml_id, leafNameCache);
    }

    // Demand signals, keyed by the listing id (siteId + ml_public_id). Open for
    // ANY item (unlike /items/{id} which is 403 for non-owners).
    let rating: number | null = null;
    let review_count: number | null = null;
    let review_levels: ReviewLevels | null = null;
    let weekly_visits: number | null = null;
    if (ml_public_id) {
      const listingId = `${item.site_id}${ml_public_id}`;
      const [reviews, visits] = await Promise.all([
        this.mlClient.getItemReviews(listingId),
        this.mlClient.getItemVisits(listingId),
      ]);
      rating = reviews?.rating ?? null;
      review_count = reviews?.total ?? null;
      review_levels = reviews?.levels ?? null;
      weekly_visits = visits;
    }

    return { ml_public_id, date_created, leaf_category_name, rating, review_count, review_levels, weekly_visits };
  }
}

/** Builds the phase-2 ML-enrichment input from a staged raw product. */
function toEnrichInput(siteId: string, r: RawScrapedProduct): EnrichInput {
  return {
    site_id: siteId,
    catalog_id: r.catalog_id,
    ml_public_id: r.ml_public_id,
    product_url: r.product_url,
    leaf_category_ml_id: r.leaf_category_ml_id,
    date_created_from_page: r.date_created_from_page,
  };
}

/** Merges phase-1 raw + phase-2 enrichment into the final persist-ready product. */
function mergeEnriched(raw: RawScrapedProduct, e: EnrichResult): EnrichedProduct {
  return {
    name: raw.name,
    price: raw.price,
    product_url: raw.product_url,
    ranking_position: raw.ranking_position,
    catalog_id: raw.catalog_id,
    ml_public_id: e.ml_public_id ?? raw.ml_public_id,
    date_created: e.date_created,
    sold_count: raw.sold_count,
    brand: raw.brand,
    original_price: raw.original_price,
    discount_pct: raw.discount_pct,
    shipping_type: raw.shipping_type,
    listing_type_id: raw.listing_type_id,
    is_cbt: raw.is_cbt,
    available_quantity: raw.available_quantity,
    installments_quantity: raw.installments_quantity,
    installments_amount: raw.installments_amount,
    installments_interest_free: raw.installments_interest_free,
    rating: e.rating,
    review_count: e.review_count,
    review_levels: e.review_levels,
    weekly_visits: e.weekly_visits,
    currency: raw.currency,
    exchange_rate: raw.exchange_rate,
    usd_price: raw.usd_price,
    usd_original_price: raw.usd_original_price,
    holiday_name: raw.holiday_name,
    leaf_category_ml_id: raw.leaf_category_ml_id,
    leaf_category_name: e.leaf_category_name,
    seller_ml_id: raw.seller_ml_id,
    seller_nickname: raw.seller_nickname,
    seller_is_official_store: raw.seller_is_official_store,
    seller_power_status: raw.seller_power_status,
    seller_total_products: raw.seller_total_products,
    seller_total_sales: raw.seller_total_sales,
  };
}
