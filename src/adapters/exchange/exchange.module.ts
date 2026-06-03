import { Module } from '@nestjs/common';
import { ExchangeRateClient } from './exchange-rate.client';

@Module({
  providers: [ExchangeRateClient],
  exports: [ExchangeRateClient],
})
export class ExchangeModule {}
