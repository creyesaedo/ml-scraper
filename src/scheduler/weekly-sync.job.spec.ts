import { WeeklySyncJob } from './weekly-sync.job';

function makeJob(siteIds: string[] | undefined) {
  const syncRunnerService = { run: jest.fn() } as any;
  const configService = { get: jest.fn().mockReturnValue(siteIds) } as any;
  return { job: new WeeklySyncJob(syncRunnerService, configService), syncRunnerService };
}

describe('WeeklySyncJob', () => {
  it('runs a sync for each configured site', async () => {
    const { job, syncRunnerService } = makeJob(['MLC', 'MLA']);
    syncRunnerService.run.mockResolvedValue({ ok: true });

    await job.handleWeeklySync();

    expect(syncRunnerService.run).toHaveBeenCalledTimes(2);
    expect(syncRunnerService.run).toHaveBeenNthCalledWith(1, 'MLC');
    expect(syncRunnerService.run).toHaveBeenNthCalledWith(2, 'MLA');
  });

  it('continues to the next site when one fails', async () => {
    const { job, syncRunnerService } = makeJob(['MLC', 'MLA']);
    syncRunnerService.run
      .mockRejectedValueOnce(new Error('MLC failed'))
      .mockResolvedValueOnce({ ok: true });

    await expect(job.handleWeeklySync()).resolves.toBeUndefined();
    expect(syncRunnerService.run).toHaveBeenCalledTimes(2);
  });

  it('falls back to MLA when no sites are configured', async () => {
    const { job, syncRunnerService } = makeJob(undefined);
    syncRunnerService.run.mockResolvedValue({});

    await job.handleWeeklySync();

    expect(syncRunnerService.run).toHaveBeenCalledWith('MLA');
  });
});
