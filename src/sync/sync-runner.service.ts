import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CategorySyncService } from './category-sync.service';
import { ProductCollectionService } from './product-collection.service';

/**
 * Top-level orchestrator for a full sync of one site. It is the single entry
 * point shared by all three triggers (GitHub Actions, CLI, and HTTP API).
 */
@Injectable()
export class SyncRunnerService {
  private readonly logger = new Logger(SyncRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly categorySyncService: CategorySyncService,
    private readonly productCollectionService: ProductCollectionService,
  ) {}

  /**
   * Runs a complete sync for a single site:
   *   1. If the site has no categories yet, syncs the category tree first.
   *   2. Always runs product collection (scraping + enrichment).
   *
   * Each step is wrapped in its own try/catch so a failure in one does not stop
   * the other, and the returned object always carries structured status/error
   * info for the caller to inspect or log.
   */
  async run(siteId: string): Promise<object> {
    let catResult: object | string = 'skipped (already existed)';

    try {
      const count = await this.prisma.category.count({ where: { country: siteId } });
      if (count === 0) {
        catResult = await this.categorySyncService.sync();
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(`Category sync failed: ${msg}`);
      catResult = { error: msg };
    }

    let prodResult: object = { error: 'not started' };

    try {
      prodResult = await this.productCollectionService.collect(siteId);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(`Product collection failed: ${msg}`);
      prodResult = { error: msg };
    }

    return {
      categories_synced: catResult,
      products: prodResult,
    };
  }
}
