import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pLimit from 'p-limit';
import { HolidaysClient } from '../adapters/holidays/holidays.client';
import { MercadoLibreClient } from '../adapters/mercadolibre/mercadolibre.client';
import { EMPTY_ENRICHMENT } from '../adapters/scraper/ml-parsers';
import { MlScraperService } from '../adapters/scraper/ml-scraper.service';
import {
  CircuitBreakerOpenError,
  ScraperHealthService,
} from '../adapters/scraper/scraper-health.service';
import { PrismaService } from '../prisma/prisma.service';

export interface CollectionResult {
  site_id: string;
  sync_run_id: string;
  categorias_procesadas: number;
  productos_guardados: number;
  snapshot_date: string;
  errores?: string[];
  aborted?: {
    reason: 'circuit_breaker';
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

@Injectable()
export class ProductCollectionService {
  private readonly logger = new Logger(ProductCollectionService.name);

  // Cache per collect() run to avoid redundant DB/API calls
  private leafCategoryCache = new Map<string, number | null>();
  private sellerCache = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scraper: MlScraperService,
    private readonly mlClient: MercadoLibreClient,
    private readonly holidays: HolidaysClient,
    private readonly configService: ConfigService,
    private readonly health: ScraperHealthService,
  ) {}

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
      const created = await this.prisma.category.create({
        data: { name: data.name, country, ml_id: leafMlId, parent_id: parentDbId },
      });
      this.logger.log(`Created leaf category ${leafMlId} → "${data.name}" (parent_id=${parentDbId})`);
      this.leafCategoryCache.set(leafMlId, created.id);
      return created.id;
    } catch {
      this.leafCategoryCache.set(leafMlId, null);
      return null;
    }
  }

  async collect(siteId: string, opts: CollectOptions = {}): Promise<CollectionResult> {
    this.leafCategoryCache.clear();
    this.sellerCache.clear();
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
        categorias_procesadas: 0,
        productos_guardados: 0,
        snapshot_date: snapshotDate.toISOString(),
        errores: [`No categories found for ${siteId}. Run POST /sync/categorias first.`],
      };
    }

    // Whitelist takes precedence over limit. If neither is set → all categories (production default).
    const whitelistBySite =
      this.configService.get<Record<string, string[]>>('app.snapshotCategoriesBySite') ?? {};
    const whitelist = whitelistBySite[siteId.toUpperCase()];
    const categoryLimitN = this.configService.get<number | null>('app.snapshotCategoryLimit');

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
        categorias_procesadas: 0,
        productos_guardados: 0,
        snapshot_date: snapshotDate.toISOString(),
        errores: [`No categories matched filters for ${siteId}.`],
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
    let totalProducts = 0;
    const errors: string[] = [];
    const completedCategories: string[] = [];
    let breakerError: CircuitBreakerOpenError | null = null;

    await Promise.all(
      remaining.map((rootCat) =>
        categoryLimit(async () => {
          if (breakerError) return; // skip new work once breaker tripped
          await this.markCategoryInProgress(syncRunId, rootCat.ml_id);

          try {
            this.logger.log(`[${siteId}] Starting category ${rootCat.ml_id}`);
            const { products: scraped, enrichmentsByUrl } =
              await this.scraper.scrapeCategoryWithProducts(siteId, rootCat.ml_id, 8);

            if (!scraped.length) {
              errors.push(`${rootCat.ml_id}: sin resultados`);
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
            await this.prisma.product.createMany({
              data: enriched.map((p) => ({
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
              })),
            });

            totalProducts += enriched.length;
            this.logger.log(`Saved ${enriched.length} products for category ${rootCat.ml_id}`);
            await this.markCategoryDone(syncRunId, rootCat.ml_id);
            completedCategories.push(rootCat.ml_id);
          } catch (err) {
            if (err instanceof CircuitBreakerOpenError) {
              breakerError = err;
              await this.markCategoryFailed(syncRunId, rootCat.ml_id, err.message);
              return;
            }
            const msg = (err as Error).message;
            errors.push(`${rootCat.ml_id}: ${msg}`);
            await this.markCategoryFailed(syncRunId, rootCat.ml_id, msg);
          }
        }),
      ),
    );

    const result: CollectionResult = {
      site_id: siteId,
      sync_run_id: syncRunId,
      categorias_procesadas: completedCategories.length,
      productos_guardados: totalProducts,
      snapshot_date: snapshotDate.toISOString(),
    };
    if (errors.length) result.errores = errors;

    if (breakerError) {
      const pending = remaining
        .map((c) => c.ml_id)
        .filter((id) => !completedCategories.includes(id));
      const state = this.health.getState();
      result.aborted = {
        reason: 'circuit_breaker',
        consecutive_failures: state.consecutiveFailures,
        threshold: state.threshold,
        diagnostics_dir: state.lastDumpDir,
        pending_categories: pending,
        completed_categories: completedCategories,
      };
      this.logger.error(
        `[${siteId}] Sync aborted by circuit breaker. ` +
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

  private markCategoryInProgress(syncRunId: string, categoryMlId: string) {
    return this.prisma.syncProgress.update({
      where: { sync_run_id_category_ml_id: { sync_run_id: syncRunId, category_ml_id: categoryMlId } },
      data: { status: 'in_progress', started_at: new Date(), error_msg: null },
    });
  }

  private markCategoryDone(syncRunId: string, categoryMlId: string) {
    return this.prisma.syncProgress.update({
      where: { sync_run_id_category_ml_id: { sync_run_id: syncRunId, category_ml_id: categoryMlId } },
      data: { status: 'done', completed_at: new Date() },
    });
  }

  private markCategoryFailed(syncRunId: string, categoryMlId: string, errorMsg: string) {
    return this.prisma.syncProgress.update({
      where: { sync_run_id_category_ml_id: { sync_run_id: syncRunId, category_ml_id: categoryMlId } },
      data: { status: 'failed', completed_at: new Date(), error_msg: errorMsg.slice(0, 1000) },
    });
  }
}
