import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SyncRunnerService } from '../sync/sync-runner.service';

// @Cron decorators are evaluated at class-definition time, before the DI
// container resolves ConfigService, so we read process.env directly here.
function buildCronExpression(): string {
  const dayOfWeek = process.env.SYNC_DAY_OF_WEEK ?? 'mon';
  const hour = process.env.SYNC_HOUR ?? '3';
  const dayMap: Record<string, string> = {
    sun: '0',
    mon: '1',
    tue: '2',
    wed: '3',
    thu: '4',
    fri: '5',
    sat: '6',
  };
  const day = dayMap[dayOfWeek] ?? '1';
  return `0 ${hour} * * ${day}`;
}

@Injectable()
export class WeeklySyncJob {
  private readonly logger = new Logger(WeeklySyncJob.name);

  constructor(
    private readonly syncRunnerService: SyncRunnerService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(buildCronExpression())
  async handleWeeklySync(): Promise<void> {
    const siteId = this.configService.get<string>('app.syncSiteId') ?? 'MLA';
    this.logger.log(`Starting weekly sync for site ${siteId}`);
    try {
      const result = await this.syncRunnerService.run(siteId);
      this.logger.log(`Weekly sync completed: ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error('Weekly sync failed', err);
    }
  }
}
