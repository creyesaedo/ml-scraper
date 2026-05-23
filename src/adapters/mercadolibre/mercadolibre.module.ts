import { Module } from '@nestjs/common';
import { MercadoLibreClient } from './mercadolibre.client';

@Module({
  providers: [MercadoLibreClient],
  exports: [MercadoLibreClient],
})
export class MercadoLibreModule {}
