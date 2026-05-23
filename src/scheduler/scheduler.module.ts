import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncModule } from '../sync/sync.module';
import { WeeklySyncJob } from './weekly-sync.job';

@Module({
  imports: [ScheduleModule.forRoot(), SyncModule],
  providers: [WeeklySyncJob],
})
export class SchedulerModule {}
