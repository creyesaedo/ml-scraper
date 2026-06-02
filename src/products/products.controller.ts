import { Controller, Get, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

/**
 * Legacy product endpoint (Spanish path /productos). Kept for backward
 * compatibility; new clients should use the paginated /products endpoint in
 * ProductsV2Controller.
 */
@Controller('productos')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll(@Query('category_id') categoryId?: string) {
    const id = categoryId !== undefined ? parseInt(categoryId, 10) : undefined;
    return this.productsService.findAll(id);
  }
}
