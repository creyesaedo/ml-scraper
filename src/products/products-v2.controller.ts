import { Controller, Get, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * Main product API (/products). Exposes paginated/filterable listing plus
 * catalog search and per-product price history. Query params arrive as strings,
 * so they are parsed and clamped to safe ranges here before reaching the service.
 */
@Controller('products')
export class ProductsV2Controller {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findPaginated(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('country') country?: string,
    @Query('category_id') categoryId?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('search') search?: string,
  ) {
    return this.productsService.findPaginated({
      page: Math.max(1, parseInt(page, 10) || 1),
      limit: Math.min(100, Math.max(1, parseInt(limit, 10) || 20)),
      country,
      category_id: categoryId ? parseInt(categoryId, 10) : undefined,
      date_from: dateFrom,
      date_to: dateTo,
      search,
    });
  }

  @Get('catalog')
  findCatalog(@Query('search') search?: string) {
    return this.productsService.findCatalogProducts(search ?? '');
  }

  @Get('history')
  findHistory(
    @Query('ml_public_id') mlPublicId?: string,
    @Query('catalog_id') catalogId?: string,
  ) {
    return this.productsService.findPriceHistory({
      ml_public_id: mlPublicId,
      catalog_id: catalogId,
    });
  }
}
