import { CategorySyncService } from './category-sync.service';

function makeService() {
  const prisma = { category: { upsert: jest.fn().mockResolvedValue({}) } } as any;
  const mlClient = {
    getSites: jest.fn(),
    getSiteCategories: jest.fn(),
  } as any;
  const service = new CategorySyncService(prisma, mlClient);
  return { service, prisma, mlClient };
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
});
