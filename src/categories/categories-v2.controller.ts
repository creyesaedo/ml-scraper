import { Controller, Get, Query } from '@nestjs/common';
import { CategoriesService } from './categories.service';

@Controller('categories')
export class CategoriesV2Controller {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll(
    @Query('country') country?: string,
    @Query('parent_only') parentOnly?: string,
  ) {
    return this.categoriesService.findAll(country, parentOnly === 'true');
  }
}
