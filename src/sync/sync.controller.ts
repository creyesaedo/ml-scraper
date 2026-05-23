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

  @Post('categorias')
  syncCategorias() {
    return this.categorySyncService.sync();
  }

  @Post('productos/:siteId')
  collectProductos(@Param('siteId') siteId: string) {
    return this.productCollectionService.collect(siteId);
  }
}
