import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CategorySyncService } from './category-sync.service';
import { ProductCollectionService } from './product-collection.service';

@Injectable()
export class SyncRunnerService {
  private readonly logger = new Logger(SyncRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly categorySyncService: CategorySyncService,
    private readonly productCollectionService: ProductCollectionService,
  ) {}

  async run(siteId: string): Promise<object> {
    let catResult: object | string = 'omitido (ya existían)';

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
      categorias_sincronizadas: catResult,
      productos: prodResult,
    };
  }
}
