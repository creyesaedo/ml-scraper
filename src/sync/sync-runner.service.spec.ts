import { SyncRunnerService } from './sync-runner.service';

function makeService() {
  const prisma = { category: { count: jest.fn() } } as any;
  const categorySyncService = { sync: jest.fn() } as any;
  const productCollectionService = { collect: jest.fn() } as any;
  const service = new SyncRunnerService(prisma, categorySyncService, productCollectionService);
  return { service, prisma, categorySyncService, productCollectionService };
}

describe('SyncRunnerService', () => {
  it('syncs categories first when the site has none, then collects products', async () => {
    const { service, prisma, categorySyncService, productCollectionService } = makeService();
    prisma.category.count.mockResolvedValue(0);
    categorySyncService.sync.mockResolvedValue({ categories_saved: 5 });
    productCollectionService.collect.mockResolvedValue({ products_saved: 10 });

    const result: any = await service.run('MLC');

    expect(categorySyncService.sync).toHaveBeenCalledTimes(1);
    expect(productCollectionService.collect).toHaveBeenCalledWith('MLC');
    expect(result.categories_synced).toEqual({ categories_saved: 5 });
    expect(result.products).toEqual({ products_saved: 10 });
  });

  it('skips category sync when categories already exist', async () => {
    const { service, prisma, categorySyncService, productCollectionService } = makeService();
    prisma.category.count.mockResolvedValue(42);
    productCollectionService.collect.mockResolvedValue({ products_saved: 3 });

    const result: any = await service.run('MLC');

    expect(categorySyncService.sync).not.toHaveBeenCalled();
    expect(result.categories_synced).toBe('skipped (already existed)');
  });

  it('captures a product-collection failure as a structured error', async () => {
    const { service, prisma, productCollectionService } = makeService();
    prisma.category.count.mockResolvedValue(1);
    productCollectionService.collect.mockRejectedValue(new Error('collect blew up'));

    const result: any = await service.run('MLC');

    expect(result.products).toEqual({ error: 'collect blew up' });
  });

  it('captures a category-sync failure but still runs collection', async () => {
    const { service, prisma, categorySyncService, productCollectionService } = makeService();
    prisma.category.count.mockResolvedValue(0);
    categorySyncService.sync.mockRejectedValue(new Error('cat fail'));
    productCollectionService.collect.mockResolvedValue({ products_saved: 0 });

    const result: any = await service.run('MLC');

    expect(result.categories_synced).toEqual({ error: 'cat fail' });
    expect(productCollectionService.collect).toHaveBeenCalled();
  });
});
