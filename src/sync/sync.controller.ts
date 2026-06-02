import { Controller, Param, Post } from '@nestjs/common';
import { CategorySyncService } from './category-sync.service';
import { ProductCollectionService } from './product-collection.service';
import { SyncRunnerService } from './sync-runner.service';

@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncRunnerService: SyncRunnerService,
    private readonly categorySyncService: CategorySyncService,
    private readonly productCollectionService: ProductCollectionService,
  ) {}

  @Post('run/:siteId')
  runSync(@Param('siteId') siteId: string) {
    return this.syncRunnerService.run(siteId);
  }

  @Post('categories')
  syncCategories() {
    return this.categorySyncService.sync();
  }

  @Post('products/:siteId')
  collectProducts(@Param('siteId') siteId: string) {
    return this.productCollectionService.collect(siteId);
  }

  /**
   * Continues the most recent unfinished sync_run for this site, scraping only
   * categories that are not yet marked 'done'. Use after the circuit breaker
   * has aborted a run (see CollectionResult.aborted in the previous response).
   */
  @Post('resume/:siteId')
  resumeProducts(@Param('siteId') siteId: string) {
    return this.productCollectionService.collect(siteId, { resume: true });
  }
}
