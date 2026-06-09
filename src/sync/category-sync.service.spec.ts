import { CategorySyncService } from './category-sync.service';
import { CircuitBreakerOpenError } from '../adapters/scraper/scraper-health.service';

function makeService(configOverrides: Record<string, any> = {}) {
  const prisma = {
    category: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const mlClient = {
    getSites: jest.fn(),
    getSiteCategories: jest.fn(),
  } as any;
  const scraper = { probeCategoryBestSellers: jest.fn() } as any;
  const config = {
    probeBestSellersOnCategorySync: false,
    snapshotSiteIds: [],
    ...configOverrides,
  } as any;
  const service = new CategorySyncService(prisma, mlClient, scraper, config);
  return { service, prisma, mlClient, scraper };
}

describe('CategorySyncService', () => {
  it('upserts root categories for every site and totals them', async () => {
    const { service, prisma, mlClient } = makeService();
    mlClient.getSites.mockResolvedValue([
      { id: 'MLC', name: 'Chile' },
      { id: 'MLA', name: 'Argentina' },
    ]);
    mlClient.getSiteCategories
      .mockResolvedValueOnce([{ id: 'MLC1', name: 'A' }, { id: 'MLC2', name: 'B' }])
      .mockResolvedValueOnce([{ id: 'MLA1', name: 'C' }]);

    const result = await service.sync();

    expect(result.countries_processed).toBe(2);
    expect(result.categories_saved).toBe(3);
    expect(result.errors).toBeUndefined();
    expect(prisma.category.upsert).toHaveBeenCalledTimes(3);
    expect(prisma.category.upsert).toHaveBeenCalledWith({
      where: { ml_id: 'MLC1' },
      create: { name: 'A', country: 'MLC', ml_id: 'MLC1' },
      update: { name: 'A', country: 'MLC' },
    });
  });

  it('collects per-site failures in errors without stopping other sites', async () => {
    const { service, prisma, mlClient } = makeService();
    mlClient.getSites.mockResolvedValue([
      { id: 'MLC', name: 'Chile' },
      { id: 'MLA', name: 'Argentina' },
    ]);
    mlClient.getSiteCategories
      .mockRejectedValueOnce(new Error('ML down'))
      .mockResolvedValueOnce([{ id: 'MLA1', name: 'C' }]);

    const result = await service.sync();

    expect(result.categories_saved).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toContain('MLC');
    expect(prisma.category.upsert).toHaveBeenCalledTimes(1);
  });

  it('does not probe when probing is disabled', async () => {
    const { service, mlClient, scraper } = makeService({ probeBestSellersOnCategorySync: false });
    mlClient.getSites.mockResolvedValue([{ id: 'MLC', name: 'Chile' }]);
    mlClient.getSiteCategories.mockResolvedValue([{ id: 'MLC1', name: 'A' }]);

    const result = await service.sync();

    expect(scraper.probeCategoryBestSellers).not.toHaveBeenCalled();
    expect(result.categories_probed).toBeUndefined();
  });

  it('probes in-scope sites and flags categories without a best-sellers page', async () => {
    const { service, prisma, mlClient, scraper } = makeService({
      probeBestSellersOnCategorySync: true,
      snapshotSiteIds: ['MLC'],
    });
    mlClient.getSites.mockResolvedValue([{ id: 'MLC', name: 'Chile' }]);
    mlClient.getSiteCategories.mockResolvedValue([
      { id: 'MLC1', name: 'A' },
      { id: 'MLC2', name: 'B' },
      { id: 'MLC3', name: 'C' },
      { id: 'MLC4', name: 'D' },
    ]);
    prisma.category.findMany.mockResolvedValue([
      { id: 1, ml_id: 'MLC1' },
      { id: 2, ml_id: 'MLC2' },
      { id: 3, ml_id: 'MLC3' },
      { id: 4, ml_id: 'MLC4' },
    ]);
    scraper.probeCategoryBestSellers.mockImplementation((_site: string, mlId: string) => {
      if (mlId === 'MLC1') return Promise.resolve('has_products');
      if (mlId === 'MLC2') return Promise.resolve('empty');
      if (mlId === 'MLC3') return Promise.resolve('no_page');
      return Promise.resolve('failed'); // MLC4 — inconclusive, must NOT be written
    });

    const result = await service.sync();

    expect(result.categories_probed).toBe(4);
    expect(result.marked_without_bestsellers).toBe(2); // MLC2 + MLC3
    // MLC1 → true, MLC2/MLC3 → false, MLC4 (failed) → not written at all.
    expect(prisma.category.update).toHaveBeenCalledTimes(3);
    expect(prisma.category.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, data: expect.objectContaining({ has_bestsellers: true }) }),
    );
    expect(prisma.category.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 2 }, data: expect.objectContaining({ has_bestsellers: false }) }),
    );
    const updatedIds = prisma.category.update.mock.calls.map((c: any[]) => c[0].where.id);
    expect(updatedIds).not.toContain(4);
  });

  it('stops probing on a run-level abort without throwing', async () => {
    const { service, prisma, mlClient, scraper } = makeService({
      probeBestSellersOnCategorySync: true,
      snapshotSiteIds: ['MLC'],
    });
    mlClient.getSites.mockResolvedValue([{ id: 'MLC', name: 'Chile' }]);
    mlClient.getSiteCategories.mockResolvedValue([{ id: 'MLC1', name: 'A' }]);
    prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1' }]);
    scraper.probeCategoryBestSellers.mockRejectedValue(new CircuitBreakerOpenError());

    const result = await service.sync();

    expect(result.errors?.some((e) => /probe aborted/i.test(e))).toBe(true);
    expect(prisma.category.update).not.toHaveBeenCalled();
  });
});
