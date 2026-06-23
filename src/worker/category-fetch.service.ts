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
  siteIdFromUrl,
} from '../adapters/scraper/ml-parsers';
import { MlScraperService } from '../adapters/scraper/ml-scraper.service';
import { ScraperHealthService } from '../adapters/scraper/scraper-health.service';
import appConfig from '../config/app.config';
import { EnrichedProduct } from './enriched-product.dto';

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
    const leafNameCache = new Map<string, string | null>();
    const limit = pLimit(productConcurrency);

    return Promise.all(
      products.map((p) =>
        limit(async () => {
          const pageData = p.product_url
            ? enrichmentsByUrl.get(p.product_url) ?? EMPTY_ENRICHMENT
            : EMPTY_ENRICHMENT;
          return this.buildEnriched(p, pageData, siteId, currency, exchangeRate, holidayName, leafNameCache);
        }),
      ),
    );
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
      ranking_position: 0,
    };
    return this.buildEnriched(
      scraped,
      enrichment,
      siteId,
      currency,
      exchangeRate,
      holidayName,
      new Map(),
    );
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

  /** Assembles the persist-ready DTO from listing + page + API/FX/holiday data. */
  private async buildEnriched(
    p: ScrapedProduct,
    pageData: ProductEnrichment,
    siteId: string,
    currency: string | null,
    exchangeRate: number | null,
    holidayName: string | null,
    leafNameCache: Map<string, string | null>,
  ): Promise<EnrichedProduct> {
    const effectiveCatalogId = p.catalog_id ?? pageData.catalog_product_id_from_page ?? null;

    const apiData = effectiveCatalogId
      ? await this.mlClient.getCatalogProduct(effectiveCatalogId)
      : null;
    const date_created = apiData?.date_created ?? pageData.date_created_from_page ?? null;

    // Listing id (ml_public_id): prefer the scraped page; if it didn't yield one
    // (render race / parser miss), fall back to the catalog API's buy-box winner.
    // The API returns it site-prefixed ("MCO3975198228") — strip the prefix to
    // match the page parser, which stores digits only.
    const ml_public_id =
      pageData.ml_public_id ??
      (apiData?.buy_box_winner_item_id
        ? apiData.buy_box_winner_item_id.replace(/^M[A-Z]{2}/, '')
        : null);

    let leaf_category_name: string | null = null;
    if (pageData.leaf_category_id) {
      leaf_category_name = await this.resolveLeafName(pageData.leaf_category_id, leafNameCache);
    }

    return {
      name: p.name,
      price: p.price,
      product_url: p.product_url,
      ranking_position: p.ranking_position,
      catalog_id: effectiveCatalogId,
      ml_public_id,
      date_created,
      sold_count: pageData.sold_count,
      rating: pageData.rating,
      review_count: pageData.review_count,
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
      leaf_category_name,
      seller_ml_id: pageData.seller_ml_id,
      seller_nickname: pageData.seller_nickname,
      seller_is_official_store: pageData.seller_is_official_store,
      seller_power_status: pageData.seller_power_status,
      seller_total_products: pageData.seller_total_products,
      seller_total_sales: pageData.seller_total_sales,
    };
  }
}
