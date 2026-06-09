import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import pLimit from 'p-limit';
import { MercadoLibreClient } from '../adapters/mercadolibre/mercadolibre.client';
import { MlScraperService } from '../adapters/scraper/ml-scraper.service';
import { ScraperAbortError } from '../adapters/scraper/scraper-health.service';
import appConfig from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';

export interface CategorySyncResult {
  countries_processed: number;
  categories_saved: number;
  /** Categories probed for a best-sellers page (only the in-scope sites). */
  categories_probed?: number;
  /** Of those probed, how many were flagged as having no usable best-sellers page. */
  marked_without_bestsellers?: number;
  errors?: string[];
}

/**
 * Keeps the local category tree in sync with MercadoLibre's official API. This
 * is the cheap, API-only step (no scraping) that must run before product
 * collection, since collection reads parent categories from the database.
 *
 * After syncing, it runs a one-request-per-category probe (Decodo) for the
 * in-scope sites only (`snapshotSiteIds` — Core 7 in production) to flag which
 * parent categories actually have a usable /mas-vendidos page. The product
 * collector then skips the ones flagged `has_bestsellers = false`, so it never
 * wastes a request scraping e.g. vehicles, real estate, services, or the
 * auth-gated Perú verticals.
 */
@Injectable()
export class CategorySyncService {
  private readonly logger = new Logger(CategorySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mlClient: MercadoLibreClient,
    private readonly scraper: MlScraperService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  /**
   * Syncs the root category tree for every MercadoLibre site into the database.
   *
   * For each site it fetches the root categories from the official API and
   * upserts them (insert if new, update the name if already present). Sites are
   * processed one after another, but the categories within a site are upserted
   * in parallel. A failure on one site is logged and collected in `errors`; it
   * does not stop the remaining sites.
   *
   * Then, unless disabled, it probes the in-scope sites' parent categories for a
   * best-sellers page and records `has_bestsellers` on each.
   */
  async sync(): Promise<CategorySyncResult> {
    const sites = await this.mlClient.getSites();
    const errors: string[] = [];
    let totalSaved = 0;

    for (const site of sites) {
      try {
        const rootCats = await this.mlClient.getSiteCategories(site.id);

        await Promise.all(
          rootCats.map((rc) =>
            this.prisma.category.upsert({
              where: { ml_id: rc.id },
              create: { name: rc.name, country: site.id, ml_id: rc.id },
              update: { name: rc.name, country: site.id },
            }),
          ),
        );

        totalSaved += rootCats.length;
        this.logger.log(`[${site.id}] ${site.name}: ${rootCats.length} categories`);
      } catch (err) {
        const msg = `[${site.id}] ${(err as Error).message}`;
        this.logger.error(msg);
        errors.push(msg);
      }
    }

    const result: CategorySyncResult = {
      countries_processed: sites.length,
      categories_saved: totalSaved,
    };

    if (this.config.probeBestSellersOnCategorySync) {
      const probe = await this.probeBestSellers(this.config.snapshotSiteIds, errors);
      result.categories_probed = probe.probed;
      result.marked_without_bestsellers = probe.markedFalse;
    }

    if (errors.length) result.errors = errors;
    return result;
  }

  /**
   * Probes every parent category of the given sites for a usable /mas-vendidos
   * page (1 Decodo request each, no product pages) and records the verdict on
   * the category row. Only definitive verdicts are persisted — a transient
   * failure leaves the flag untouched so a glitch never blacklists a category.
   * A run-level abort (circuit breaker / Decodo account error) stops the probe
   * but does not throw: category sync still returns its result.
   */
  private async probeBestSellers(
    siteIds: string[],
    errors: string[],
  ): Promise<{ probed: number; markedFalse: number }> {
    let probed = 0;
    let markedFalse = 0;
    const limit = pLimit(8);

    for (const siteId of siteIds) {
      const parents = await this.prisma.category.findMany({
        where: { country: siteId, parent_id: null },
        orderBy: { id: 'asc' },
        select: { id: true, ml_id: true },
      });
      if (!parents.length) continue;

      this.logger.log(`[${siteId}] Probing ${parents.length} parent categories for best-sellers`);
      let aborted = false;

      await Promise.all(
        parents.map((cat) =>
          limit(async () => {
            if (aborted) return;
            let verdict: 'has_products' | 'empty' | 'no_page' | 'failed';
            try {
              verdict = await this.scraper.probeCategoryBestSellers(siteId, cat.ml_id);
            } catch (err) {
              if (err instanceof ScraperAbortError) {
                aborted = true;
                const msg = `[${siteId}] Best-sellers probe aborted: ${err.message}`;
                this.logger.error(msg);
                errors.push(msg);
                return;
              }
              this.logger.warn(
                `[${siteId}] Probe error for ${cat.ml_id}: ${(err as Error).message}`,
              );
              return;
            }

            probed += 1;
            // 'failed' is inconclusive (network/Decodo glitch or partial render)
            // — leave the flag as-is so a transient blip never blacklists it.
            if (verdict === 'failed') return;

            const has = verdict === 'has_products';
            if (!has) markedFalse += 1;
            await this.prisma.category
              .update({
                where: { id: cat.id },
                data: { has_bestsellers: has, bestsellers_checked_at: new Date() },
              })
              .catch((err) =>
                this.logger.warn(
                  `[${siteId}] Failed to flag ${cat.ml_id}: ${(err as Error).message}`,
                ),
              );
          }),
        ),
      );
    }

    return { probed, markedFalse };
  }
}
