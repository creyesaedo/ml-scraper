import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pLimit from 'p-limit';
import { MercadoLibreClient } from '../adapters/mercadolibre/mercadolibre.client';
import { EMPTY_ENRICHMENT, MlScraperService } from '../adapters/scraper/ml-scraper.service';
import { PrismaService } from '../prisma/prisma.service';

export interface CollectionResult {
  site_id: string;
  categorias_procesadas: number;
  productos_guardados: number;
  snapshot_date: string;
  errores?: string[];
}

@Injectable()
export class ProductCollectionService {
  private readonly logger = new Logger(ProductCollectionService.name);

  // Cache per collect() run to avoid redundant DB/API calls
  private leafCategoryCache = new Map<string, number | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scraper: MlScraperService,
    private readonly mlClient: MercadoLibreClient,
    private readonly configService: ConfigService,
  ) {}

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

  async collect(siteId: string): Promise<CollectionResult> {
    this.leafCategoryCache.clear();

    let rootCategories = await this.prisma.category.findMany({
      where: { country: siteId, parent_id: null },
      orderBy: { id: 'asc' },
    });

    if (!rootCategories.length) {
      return {
        site_id: siteId,
        categorias_procesadas: 0,
        productos_guardados: 0,
        snapshot_date: new Date().toISOString(),
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
        categorias_procesadas: 0,
        productos_guardados: 0,
        snapshot_date: new Date().toISOString(),
        errores: [`No categories matched filters for ${siteId}.`],
      };
    }

    const categoryLimit = pLimit(3);
    const productLimit = pLimit(8);
    const snapshotDate = new Date();
    let totalProducts = 0;
    const errors: string[] = [];

    await Promise.all(
      rootCategories.map((rootCat) =>
        categoryLimit(async () => {
          const { products: scraped, enrichmentsByUrl } =
            await this.scraper.scrapeCategoryWithProducts(siteId, rootCat.ml_id, 8);

          if (!scraped.length) {
            errors.push(`${rootCat.ml_id}: sin resultados`);
            return;
          }

          const enriched = await Promise.all(
            scraped.map((p) =>
              productLimit(async () => {
                const pageData = p.product_url
                  ? enrichmentsByUrl.get(p.product_url) ?? EMPTY_ENRICHMENT
                  : EMPTY_ENRICHMENT;

                const effectiveCatalogId = p.catalog_id ?? pageData.catalog_product_id_from_page ?? null;
                const apiData = effectiveCatalogId
                  ? await this.mlClient.getCatalogProduct(effectiveCatalogId)
                  : null;

                const date_created =
                  apiData?.date_created
                    ? new Date(apiData.date_created)
                    : pageData.date_created_from_page
                      ? new Date(pageData.date_created_from_page)
                      : null;

                // Resolve leaf category — if found, product category_id = leaf, parent_id = root
                // If not found, product category_id = root, parent_id = null
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

                return {
                  ...p,
                  catalog_id: effectiveCatalogId,
                  date_created,
                  category_id,
                  parent_id,
                  ...pageData,
                };
              }),
            ),
          );

          await this.prisma.product.createMany({
            data: enriched.map((p) => ({
              name: p.name,
              price: p.price,
              country: siteId,
              category_id: p.category_id,
              parent_id: p.parent_id,
              snapshot_date: snapshotDate,
              catalog_id: p.catalog_id,
              listing_id: p.listing_id,
              date_created: p.date_created,
              sold_count: p.sold_count,
              rating: p.rating,
              review_count: p.review_count,
              brand: p.brand,
            })),
          });

          totalProducts += enriched.length;
          this.logger.log(`Saved ${enriched.length} products for category ${rootCat.ml_id}`);
        }),
      ),
    );

    const result: CollectionResult = {
      site_id: siteId,
      categorias_procesadas: rootCategories.length,
      productos_guardados: totalProducts,
      snapshot_date: snapshotDate.toISOString(),
    };
    if (errors.length) result.errores = errors;
    return result;
  }
}
