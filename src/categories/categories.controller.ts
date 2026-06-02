import { Controller, Get, Query } from '@nestjs/common';
import { CategoriesService } from './categories.service';

/**
 * Category API (/categories). Lists categories, optionally filtered by country,
 * with a `parent_only` flag to return just root categories.
 */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll(
    @Query('country') country?: string,
    @Query('parent_only') parentOnly?: string,
  ) {
    return this.categoriesService.findAll(country, parentOnly === 'true');
  }
}
