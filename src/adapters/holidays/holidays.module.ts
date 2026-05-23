import { Module } from '@nestjs/common';
import { HolidaysClient } from './holidays.client';

@Module({
  providers: [HolidaysClient],
  exports: [HolidaysClient],
})
export class HolidaysModule {}
