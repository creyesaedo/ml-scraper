import { Controller, Get, Query } from '@nestjs/common';
import { CategoriesService } from './categories.service';

/**
 * Legacy category endpoint (Spanish path /categorias). Kept for backward
 * compatibility; new clients should use /categories in CategoriesV2Controller.
 */
@Controller('categorias')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll(@Query('country') country?: string) {
    return this.categoriesService.findAll(country);
  }
}
