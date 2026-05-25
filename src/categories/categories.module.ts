import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller';
import { CategoriesV2Controller } from './categories-v2.controller';
import { CategoriesService } from './categories.service';

@Module({
  controllers: [CategoriesController, CategoriesV2Controller],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
