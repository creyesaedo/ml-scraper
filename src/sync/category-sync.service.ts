import { Injectable, Logger } from '@nestjs/common';
import { MercadoLibreClient } from '../adapters/mercadolibre/mercadolibre.client';
import { PrismaService } from '../prisma/prisma.service';

export interface CategorySyncResult {
  paises_procesados: number;
  categorias_guardadas: number;
  errores?: string[];
}

/**
 * Keeps the local category tree in sync with MercadoLibre's official API. This
 * is the cheap, API-only step (no scraping) that must run before product
 * collection, since collection reads parent categories from the database.
 */
@Injectable()
export class CategorySyncService {
  private readonly logger = new Logger(CategorySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mlClient: MercadoLibreClient,
  ) {}

  /**
   * Syncs the root category tree for every MercadoLibre site into the database.
   *
   * For each site it fetches the root categories from the official API and
   * upserts them (insert if new, update the name if already present). Sites are
   * processed one after another, but the categories within a site are upserted
   * in parallel. A failure on one site is logged and collected in `errores`; it
   * does not stop the remaining sites.
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
      paises_procesados: sites.length,
      categorias_guardadas: totalSaved,
    };
    if (errors.length) result.errores = errors;
    return result;
  }
}
