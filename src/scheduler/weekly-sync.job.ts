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

/**
 * Optional in-process weekly scheduler. Registered only when
 * ENABLE_INTERNAL_SCHEDULER=true; otherwise GitHub Actions drives the timing and
 * this job stays off to avoid running the sync twice.
 */
@Injectable()
export class WeeklySyncJob {
  private readonly logger = new Logger(WeeklySyncJob.name);

  constructor(
    private readonly syncRunnerService: SyncRunnerService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Fires on the configured weekly cron and runs a sync for each configured
   * site in turn. A failure on one site is logged and does not stop the rest,
   * so the scheduler never crashes mid-run.
   */
  @Cron(buildCronExpression())
  async handleWeeklySync(): Promise<void> {
    const siteIds =
      this.configService.get<string[]>('app.snapshotSiteIds') ?? ['MLA'];
    this.logger.log(
      `Starting weekly snapshot for sites: ${siteIds.join(', ')}`,
    );
    for (const siteId of siteIds) {
      try {
        const result = await this.syncRunnerService.run(siteId);
        this.logger.log(
          `[${siteId}] Snapshot completed: ${JSON.stringify(result)}`,
        );
      } catch (err) {
        this.logger.error(`[${siteId}] Snapshot failed`, err);
      }
    }
  }
}
