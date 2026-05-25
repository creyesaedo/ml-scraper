import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsV2Controller } from './products-v2.controller';
import { ProductsService } from './products.service';

@Module({
  controllers: [ProductsController, ProductsV2Controller],
  providers: [ProductsService],
})
export class ProductsModule {}
