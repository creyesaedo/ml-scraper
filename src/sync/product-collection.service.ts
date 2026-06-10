import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pLimit from 'p-limit';
import { ExchangeRateClient } from '../adapters/exchange/exchange-rate.client';
import { HolidaysClient } from '../adapters/holidays/holidays.client';
import { MercadoLibreClient } from '../adapters/mercadolibre/mercadolibre.client';
import { currencyForSite, EMPTY_ENRICHMENT } from '../adapters/scraper/ml-parsers';
import { MlScraperService } from '../adapters/scraper/ml-scraper.service';
import {
  DecodoAccountError,
  ScraperAbortError,
  ScraperHealthService,
} from '../adapters/scraper/scraper-health.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Why a run stopped early: scraper health, Decodo account, or the database. */
export type AbortReason = 'circuit_breaker' | 'decodo_account' | 'database';

export interface CollectionResult {
  site_id: string;
  sync_run_id: string;
  categories_processed: number;
  products_saved: number;
  snapshot_date: string;
  errors?: string[];
  aborted?: {
    reason: AbortReason;
    consecutive_failures: number;
    threshold: number;
    diagnostics_dir: string | null;
    pending_categories: string[];
    completed_categories: string[];
  };
}

export interface CollectOptions {
  /** When true, find the latest unfinished sync_run for this site and continue from there. */
  resume?: boolean;
}

/**
 * Converts a local-currency amount to USD given the rate (local units per 1
 * USD), rounded to 2 decimals. Returns null when the amount or rate is missing
 * or unusable, so a missing FX rate simply leaves the USD column null.
 */
function toUsd(local: number | null, rate: number | null): number | null {
  if (local == null || rate == null || !Number.isFinite(local) || rate <= 0) {
    return null;
  }
  const usd = local / rate;
  return Number.isFinite(usd) ? Math.round(usd * 100) / 100 : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * True when an error signals the database is unreachable — at connect time
 * (`PrismaClientInitializationError`) OR mid-query (the common Neon case: the
 * pooler closing idle connections, scale-to-zero, or a DNS/TCP blip). Prisma
 * surfaces the latter under different classes/codes than the init error, and the
 * pg driver may bubble the raw socket error, so we match Prisma's connection
 * codes (P1001 can't-reach, P1002/P1008 timeout, P1017 server-closed) and the
 * underlying network `cause.code` / message as well. Used both to decide whether
 * a write is worth retrying and to classify a run-level `database` abort.
 */
function isDatabaseDownError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  const code = (err as { code?: string })?.code ?? '';
  if (['P1001', 'P1002', 'P1008', 'P1017'].includes(code)) return true;
  const causeCode = (err as { cause?: { code?: string } })?.cause?.code ?? '';
  const msg = (err as Error)?.message ?? '';
  return /EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated|Can't reach database server|closed the connection/i.test(
    `${msg} ${causeCode}`,
  );
}

/**
 * The expensive half of a sync: scrapes best-seller products for a site's
 * categories, enriches them (ML API + product-page data + leaf category +
 * seller), and stores immutable snapshot rows. Progress is checkpointed per
 * category so an aborted run can be resumed. See `collect()` for the full flow.
 */
@Injectable()
export class ProductCollectionService {
  private readonly logger = new Logger(ProductCollectionService.name);

  // Caches scoped to a single collect() run (cleared on entry) to avoid
  // redundant DB writes and ML API calls for the same leaf/seller/catalog id.
  private leafCategoryCache = new Map<string, number | null>();
  private sellerCache = new Map<string, number>();
  private catalogProductCache = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scraper: MlScraperService,
    private readonly mlClient: MercadoLibreClient,
    private readonly holidays: HolidaysClient,
    private readonly exchangeRates: ExchangeRateClient,
    private readonly configService: ConfigService,
    private readonly health: ScraperHealthService,
  ) {}

  /**
   * Inserts or updates a seller profile extracted from a product page and
   * returns its DB id. Sellers are deduped by their MercadoLibre id, and the
   * result is cached per run so the same seller is written only once. Returns
   * null when there is no seller id or the write fails (the product is still
   * saved, just without a seller link).
   */
  private async upsertSeller(
    enrichment: {
      seller_ml_id: string | null;
      seller_nickname: string | null;
      seller_is_official_store: boolean;
      seller_power_status: string | null;
      seller_total_products: number | null;
      seller_total_sales: number | null;
    },
    country: string,
  ): Promise<number | null> {
    if (!enrichment.seller_ml_id) return null;
    if (this.sellerCache.has(enrichment.seller_ml_id)) {
      return this.sellerCache.get(enrichment.seller_ml_id)!;
    }

    try {
      const now = new Date();
      const seller = await this.prisma.seller.upsert({
        where: { ml_seller_id: enrichment.seller_ml_id },
        create: {
          ml_seller_id: enrichment.seller_ml_id,
          nickname: enrichment.seller_nickname,
          is_official_store: enrichment.seller_is_official_store,
          power_seller_status: enrichment.seller_power_status,
          total_products: enrichment.seller_total_products,
          total_sales: enrichment.seller_total_sales,
          country,
          first_seen: now,
          last_seen: now,
        },
        update: {
          nickname: enrichment.seller_nickname,
          is_official_store: enrichment.seller_is_official_store,
          power_seller_status: enrichment.seller_power_status,
          total_products: enrichment.seller_total_products,
          total_sales: enrichment.seller_total_sales,
          last_seen: now,
        },
      });
      this.sellerCache.set(enrichment.seller_ml_id, seller.id);
      return seller.id;
    } catch (err) {
      this.logger.warn(
        `Failed to upsert seller ${enrichment.seller_ml_id}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Records the catalog product (the stable product behind many listings) so we
   * can search it later. Inserts it the first time we see it and refreshes
   * `last_seen_at` afterwards. Cached per run to avoid repeat writes; failures
   * are logged and swallowed since this is secondary to saving the snapshot.
   */
  private async upsertCatalogProduct(
    catalogId: string,
    name: string,
    brand: string | null,
    now: Date,
  ): Promise<void> {
    if (this.catalogProductCache.has(catalogId)) return;
    try {
      await this.prisma.catalogProduct.upsert({
        where: { catalog_id: catalogId },
        create: { catalog_id: catalogId, name, brand, first_seen_at: now, last_seen_at: now },
        update: { last_seen_at: now, brand: brand ?? undefined },
      });
      this.catalogProductCache.add(catalogId);
    } catch (err) {
      this.logger.warn(`Failed to upsert catalog product ${catalogId}: ${(err as Error).message}`);
    }
  }

  /**
   * Turns the leaf (deepest) category id read from a product page into a DB
   * category id. If we already have that category it returns its id; otherwise
   * it fetches the category from the ML API and creates it under the given
   * parent. Results (including "not found", stored as null) are cached per run
   * so each leaf is resolved at most once.
   */
  private async resolveLeafCategory(
    leafMlId: string,
    parentDbId: number,
    country: string,
  ): Promise<number | null> {
    if (this.leafCategoryCache.has(leafMlId)) {
      return this.leafCategoryCache.get(leafMlId)!;
    }

    const existing = await this.prisma.category.findUnique({ where: { ml_id: leafMlId } });
    if (existing) {
      this.leafCategoryCache.set(leafMlId, existing.id);
      return existing.id;
    }

    try {
      const data = await this.mlClient.getCategory(leafMlId);
      if (!data?.name) {
        this.leafCategoryCache.set(leafMlId, null);
        return null;
      }
      // upsert (not create) to stay race-safe: up to 24 product enrichments run
      // in parallel and two can resolve the same leaf at once, both missing the
      // findUnique above. A plain create then loses the race with a unique-
      // constraint error on ml_id; upsert's ON CONFLICT returns the existing row.
      const created = await this.prisma.category.upsert({
        where: { ml_id: leafMlId },
        create: { name: data.name, country, ml_id: leafMlId, parent_id: parentDbId },
        update: { name: data.name },
      });
      this.logger.log(`Created leaf category ${leafMlId} → "${data.name}" (parent_id=${parentDbId})`);
      this.leafCategoryCache.set(leafMlId, created.id);
      return created.id;
    } catch (err) {
      this.logger.warn(
        `Failed to resolve leaf category ${leafMlId} (parent_id=${parentDbId}): ${(err as Error).message}`,
      );
      this.leafCategoryCache.set(leafMlId, null);
      return null;
    }
  }

  /**
   * Scrapes best-seller products for every in-scope parent category of a site,
   * enriches each product (ML API + product-page data + leaf category + seller)
   * and saves them as immutable snapshot rows.
   *
   * High-level flow:
   *   1. Load this site's parent categories and narrow them with the configured
   *      whitelist or limit (DEVELOPMENT mode requires a whitelist as a cost guard).
   *   2. Open or resume a sync_run and skip categories already marked 'done'.
   *   3. Process categories 3 at a time; within each, scrape and enrich up to
   *      20 products 8 at a time, then bulk-insert the snapshot rows.
   *   4. If the circuit breaker trips, stop launching new categories and return
   *      `aborted` with the pending/completed lists so the run can be resumed.
   *
   * Per-run caches and the circuit breaker are reset on entry. Individual
   * category failures are collected in `errors` and never abort the whole run.
   */
  async collect(siteId: string, opts: CollectOptions = {}): Promise<CollectionResult> {
    this.leafCategoryCache.clear();
    this.sellerCache.clear();
    this.catalogProductCache.clear();
    this.health.reset();

    let rootCategories = await this.prisma.category.findMany({
      where: { country: siteId, parent_id: null },
      orderBy: { id: 'asc' },
    });

    const snapshotDate = new Date();

    if (!rootCategories.length) {
      return {
        site_id: siteId,
        sync_run_id: '',
        categories_processed: 0,
        products_saved: 0,
        snapshot_date: snapshotDate.toISOString(),
        errors: [`No categories found for ${siteId}. Run POST /sync/categories first.`],
      };
    }

    // Skip categories already known to have no usable /mas-vendidos page
    // (has_bestsellers = false — set by the category-sync probe). null/true are
    // kept: null means "never evaluated, try it"; true means "has a ranking".
    // This avoids one wasted Decodo request per dead category every run.
    if (this.configService.get<boolean>('app.skipKnownEmptyCategories')) {
      const before = rootCategories.length;
      rootCategories = rootCategories.filter((c) => c.has_bestsellers !== false);
      const skipped = before - rootCategories.length;
      if (skipped > 0) {
        this.logger.log(
          `[${siteId}] Skipping ${skipped} categories flagged without a best-sellers page`,
        );
      }
    }

    // Whitelist takes precedence over limit. If neither is set → all categories (production default).
    const whitelistBySite =
      this.configService.get<Record<string, string[]>>('app.snapshotCategoriesBySite') ?? {};
    const whitelist = whitelistBySite[siteId.toUpperCase()];
    const categoryLimitN = this.configService.get<number | null>('app.snapshotCategoryLimit');

    // Safety net: in DEVELOPMENT mode the whitelist MUST be populated. If we
    // reach this point with an empty whitelist, something upstream (CLI override,
    // config wiring) failed and processing all parent categories would cost
    // ~$1 per site instead of ~$0.03. Abort loudly to keep dev runs cheap.
    const appMode = this.configService.get<string>('app.appMode');
    if (appMode === 'DEVELOPMENT' && !whitelist?.length) {
      throw new Error(
        `[${siteId}] DEVELOPMENT mode requires a whitelist but none is set. ` +
          `Aborting before any Decodo spend. Verify the CLI overrode ` +
          `app.snapshotCategoriesBySite before invoking collect().`,
      );
    }

    if (whitelist?.length) {
      const set = new Set(whitelist);
      const before = rootCategories.length;
      rootCategories = rootCategories.filter((c) => set.has(c.ml_id));
      this.logger.log(
        `[${siteId}] Whitelist active: ${rootCategories.length}/${before} categories selected (${whitelist.join(', ')})`,
      );
      const missing = whitelist.filter((id) => !rootCategories.some((c) => c.ml_id === id));
      if (missing.length) {
        this.logger.warn(`[${siteId}] Whitelisted categories not found in DB: ${missing.join(', ')}`);
      }
    } else if (categoryLimitN && categoryLimitN > 0) {
      const before = rootCategories.length;
      rootCategories = rootCategories.slice(0, categoryLimitN);
      this.logger.log(
        `[${siteId}] Category limit active: ${rootCategories.length}/${before} categories selected`,
      );
    }

    if (!rootCategories.length) {
      return {
        site_id: siteId,
        sync_run_id: '',
        categories_processed: 0,
        products_saved: 0,
        snapshot_date: snapshotDate.toISOString(),
        errors: [`No categories matched filters for ${siteId}.`],
      };
    }

    // Resolve sync_run_id (resume existing or open a fresh one) and seed
    // checkpoint rows. Done categories from a resumed run are skipped below.
    const { syncRunId, doneCategoryIds } = await this.openSyncRun(siteId, rootCategories, opts);
    const remaining = rootCategories.filter((c) => !doneCategoryIds.has(c.ml_id));

    if (opts.resume) {
      this.logger.log(
        `[${siteId}] Resuming sync_run ${syncRunId}: ${doneCategoryIds.size} done, ${remaining.length} pending`,
      );
    } else {
      this.logger.log(`[${siteId}] Starting fresh sync_run ${syncRunId} (${remaining.length} categories)`);
    }

    const categoryLimit = pLimit(3);
    const productLimit = pLimit(8);
    const holidayName = await this.holidays.getHolidayName(snapshotDate, siteId);

    // Resolve the FX rate once per run (collect() is per-site = one currency).
    // The rate is cached per day inside the client, so a multi-site run still
    // makes a single network call. A null rate (unknown site or fetch failure)
    // leaves the USD columns null and never aborts the run.
    const currency = currencyForSite(siteId);
    const exchangeRate = currency
      ? await this.exchangeRates.getRate(currency, snapshotDate)
      : null;
    if (currency && exchangeRate == null) {
      this.logger.warn(
        `[${siteId}] No FX rate for ${currency}; usd_price will be null for this run`,
      );
    }

    let totalProducts = 0;
    const errors: string[] = [];
    const completedCategories: string[] = [];
    // Set when a run-level failure occurs (circuit breaker, Decodo account
    // error, or DB unreachable). Once set, no new categories are launched and
    // the run ends with `aborted` populated so it can be resumed.
    let abortError: Error | null = null;
    let abortReason: AbortReason | null = null;

    await Promise.all(
      remaining.map((rootCat) =>
        categoryLimit(async () => {
          if (abortError) return; // skip new work once a fatal failure occurred

          try {
            await this.markCategoryInProgress(syncRunId, rootCat.ml_id);
            this.logger.log(`[${siteId}] Starting category ${rootCat.ml_id}`);
            const { products: scraped, enrichmentsByUrl } =
              await this.scraper.scrapeCategoryWithProducts(siteId, rootCat.ml_id, 8);

            if (!scraped.length) {
              errors.push(`${rootCat.ml_id}: no results`);
              await this.markCategoryDone(syncRunId, rootCat.ml_id);
              completedCategories.push(rootCat.ml_id);
              return;
            }

            this.logger.log(
              `[${siteId}] ${rootCat.ml_id}: enriching ${scraped.length} products via ML API + resolving leaf categories`,
            );
            const enrichStart = Date.now();
            const enriched = await Promise.all(
              scraped.map((p) =>
                productLimit(async () => {
                  const pageData = p.product_url
                    ? enrichmentsByUrl.get(p.product_url) ?? EMPTY_ENRICHMENT
                    : EMPTY_ENRICHMENT;

                  const effectiveCatalogId =
                    p.catalog_id ?? pageData.catalog_product_id_from_page ?? null;

                  if (effectiveCatalogId) {
                    await this.upsertCatalogProduct(
                      effectiveCatalogId,
                      p.name,
                      pageData.brand,
                      snapshotDate,
                    );
                  }

                  const apiData = effectiveCatalogId
                    ? await this.mlClient.getCatalogProduct(effectiveCatalogId)
                    : null;

                  const date_created = apiData?.date_created
                    ? new Date(apiData.date_created)
                    : pageData.date_created_from_page
                      ? new Date(pageData.date_created_from_page)
                      : null;

                  let category_id = rootCat.id;
                  let parent_id: number | null = null;

                  if (pageData.leaf_category_id) {
                    const leafId = await this.resolveLeafCategory(
                      pageData.leaf_category_id,
                      rootCat.id,
                      siteId,
                    );
                    if (leafId) {
                      category_id = leafId;
                      parent_id = rootCat.id;
                    }
                  }

                  const seller_id = await this.upsertSeller(pageData, siteId);

                  return {
                    ...p,
                    catalog_id: effectiveCatalogId,
                    date_created,
                    category_id,
                    parent_id,
                    seller_id,
                    ...pageData,
                  };
                }),
              ),
            );

            this.logger.log(
              `[${siteId}] ${rootCat.ml_id}: enrichment finished in ${((Date.now() - enrichStart) / 1000).toFixed(1)}s — inserting ${enriched.length} rows`,
            );
            const snapshotRows = enriched.map((p) => ({
              name: p.name,
              price: p.price,
              country: siteId,
              category_id: p.category_id,
              parent_id: p.parent_id,
              seller_id: p.seller_id,
              snapshot_date: snapshotDate,
              catalog_id: p.catalog_id,
              ml_public_id: p.ml_public_id,
              date_created: p.date_created,
              sold_count: p.sold_count,
              rating: p.rating,
              review_count: p.review_count,
              brand: p.brand,
              holiday_name: holidayName,
              ranking_position: p.ranking_position,
              original_price: p.original_price,
              discount_pct: p.discount_pct,
              shipping_type: p.shipping_type,
              listing_type_id: p.listing_type_id,
              is_cbt: p.is_cbt,
              currency,
              exchange_rate: exchangeRate,
              usd_price: toUsd(Number(p.price), exchangeRate),
              usd_original_price: toUsd(p.original_price, exchangeRate),
              available_quantity: p.available_quantity,
              installments_quantity: p.installments_quantity,
              installments_amount: p.installments_amount,
              installments_interest_free: p.installments_interest_free,
            }));
            await this.withDbRetry(
              () => this.prisma.product.createMany({ data: snapshotRows }),
              `createMany ${rootCat.ml_id}`,
            );

            totalProducts += enriched.length;
            this.logger.log(`Saved ${enriched.length} products for category ${rootCat.ml_id}`);
            await this.markCategoryDone(syncRunId, rootCat.ml_id);
            completedCategories.push(rootCat.ml_id);
          } catch (err) {
            // Run-level scraper aborts: circuit breaker or Decodo account error.
            if (err instanceof ScraperAbortError) {
              abortError = err;
              abortReason =
                err instanceof DecodoAccountError ? 'decodo_account' : 'circuit_breaker';
              await this.markCategoryFailed(syncRunId, rootCat.ml_id, err.message);
              return;
            }
            // Database unreachable (e.g. Neon asleep/down, pooler dropped the
            // connection mid-query). The writes above already retried transient
            // blips via withDbRetry, so reaching here means it did not recover:
            // every later save would fail the same way, so abort instead of
            // paying Decodo for data we cannot store. Guard the checkpoint write
            // — it hits the same dead DB — so it never masks the original error.
            if (isDatabaseDownError(err)) {
              abortError = err as Error;
              abortReason = 'database';
              this.logger.error(
                `[${siteId}] Database unreachable — aborting sync: ${(err as Error).message}`,
              );
              await this.markCategoryFailed(syncRunId, rootCat.ml_id, (err as Error).message).catch(
                () => undefined,
              );
              return;
            }
            const msg = (err as Error).message;
            errors.push(`${rootCat.ml_id}: ${msg}`);
            // Guard: a checkpoint write can itself fail (e.g. the DB just went
            // down). Don't let that reject the closure and crash the whole run —
            // the next category's withDbRetry / abort path will catch a real outage.
            await this.markCategoryFailed(syncRunId, rootCat.ml_id, msg).catch(() => undefined);
          }
        }),
      ),
    );

    const result: CollectionResult = {
      site_id: siteId,
      sync_run_id: syncRunId,
      categories_processed: completedCategories.length,
      products_saved: totalProducts,
      snapshot_date: snapshotDate.toISOString(),
    };
    if (errors.length) result.errors = errors;

    // Casts: TS does not track these let-variables being mutated inside the
    // Promise.all closures above, so after the loop it still believes they are
    // null. Reassert their real types before reading them.
    const fatalError = abortError as Error | null;
    const fatalReason = abortReason as AbortReason | null;
    if (fatalError && fatalReason) {
      const pending = remaining
        .map((c) => c.ml_id)
        .filter((id) => !completedCategories.includes(id));
      const state = this.health.getState();
      result.aborted = {
        reason: fatalReason,
        consecutive_failures: state.consecutiveFailures,
        threshold: state.threshold,
        diagnostics_dir: state.lastDumpDir,
        pending_categories: pending,
        completed_categories: completedCategories,
      };
      this.logger.error(
        `[${siteId}] Sync aborted (${fatalReason}): ${fatalError.message}. ` +
          `${completedCategories.length}/${remaining.length} done. ` +
          `Resume with: POST /sync/resume/${siteId}`,
      );
    }

    return result;
  }

  /**
   * Resolves the sync_run_id and ensures sync_progress rows exist for every
   * category in scope. Returns the IDs of categories already marked 'done'
   * so they can be skipped (relevant only when opts.resume is true).
   */
  private async openSyncRun(
    siteId: string,
    rootCategories: Array<{ ml_id: string }>,
    opts: CollectOptions,
  ): Promise<{ syncRunId: string; doneCategoryIds: Set<string> }> {
    if (opts.resume) {
      const latest = await this.prisma.syncProgress.findFirst({
        where: {
          country: siteId,
          status: { in: ['pending', 'in_progress', 'failed'] },
        },
        orderBy: { created_at: 'desc' },
        select: { sync_run_id: true },
      });
      if (!latest) {
        throw new Error(`No resumable sync_run found for ${siteId}`);
      }
      const done = await this.prisma.syncProgress.findMany({
        where: { sync_run_id: latest.sync_run_id, status: 'done' },
        select: { category_ml_id: true },
      });
      // Reset 'in_progress' / 'failed' rows so they go through the loop again.
      await this.prisma.syncProgress.updateMany({
        where: {
          sync_run_id: latest.sync_run_id,
          status: { in: ['in_progress', 'failed'] },
        },
        data: { status: 'pending', error_msg: null, started_at: null },
      });
      return {
        syncRunId: latest.sync_run_id,
        doneCategoryIds: new Set(done.map((r) => r.category_ml_id)),
      };
    }

    const syncRunId = `${siteId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await this.prisma.syncProgress.createMany({
      data: rootCategories.map((c) => ({
        sync_run_id: syncRunId,
        country: siteId,
        category_ml_id: c.ml_id,
        status: 'pending',
      })),
      skipDuplicates: true,
    });
    return { syncRunId, doneCategoryIds: new Set<string>() };
  }

  /**
   * Runs a DB operation, retrying on transient connection errors (a brief Neon
   * blip — pooler reconnect, scale-to-zero wake) which usually clear within
   * seconds. Non-transient errors throw immediately. If every attempt fails the
   * last error propagates, so the caller can still classify a `database` abort.
   */
  private async withDbRetry<T>(op: () => Promise<T>, label: string, attempts = 3): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await op();
      } catch (err) {
        lastErr = err;
        if (attempt < attempts && isDatabaseDownError(err)) {
          const wait = 1000 * attempt;
          this.logger.warn(
            `DB op '${label}' failed (attempt ${attempt}/${attempts}): ` +
              `${(err as Error).message} — retrying in ${wait}ms`,
          );
          await sleep(wait);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // The three helpers below move a category's checkpoint row through its
  // lifecycle (in_progress → done | failed). The sync_progress table is the
  // source of truth used by resume to know what still needs scraping. Each is
  // wrapped in withDbRetry so a transient Neon blip doesn't lose a checkpoint.

  private markCategoryInProgress(syncRunId: string, categoryMlId: string) {
    return this.withDbRetry(
      () =>
        this.prisma.syncProgress.update({
          where: { sync_run_id_category_ml_id: { sync_run_id: syncRunId, category_ml_id: categoryMlId } },
          data: { status: 'in_progress', started_at: new Date(), error_msg: null },
        }),
      `markCategoryInProgress ${categoryMlId}`,
    );
  }

  private markCategoryDone(syncRunId: string, categoryMlId: string) {
    return this.withDbRetry(
      () =>
        this.prisma.syncProgress.update({
          where: { sync_run_id_category_ml_id: { sync_run_id: syncRunId, category_ml_id: categoryMlId } },
          data: { status: 'done', completed_at: new Date() },
        }),
      `markCategoryDone ${categoryMlId}`,
    );
  }

  private markCategoryFailed(syncRunId: string, categoryMlId: string, errorMsg: string) {
    return this.withDbRetry(
      () =>
        this.prisma.syncProgress.update({
          where: { sync_run_id_category_ml_id: { sync_run_id: syncRunId, category_ml_id: categoryMlId } },
          data: { status: 'failed', completed_at: new Date(), error_msg: errorMsg.slice(0, 1000) },
        }),
      `markCategoryFailed ${categoryMlId}`,
    );
  }
}
