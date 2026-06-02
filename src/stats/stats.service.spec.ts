import { StatsService } from './stats.service';

describe('StatsService', () => {
  it('aggregates the dashboard summary from parallel queries', async () => {
    const snapshot = new Date('2026-06-01T00:00:00Z');
    const prisma = {
      product: {
        count: jest.fn().mockResolvedValue(100),
        findFirst: jest.fn().mockResolvedValue({ snapshot_date: snapshot }),
        groupBy: jest.fn().mockResolvedValue([
          { country: 'MLC', _count: { id: 60 } },
          { country: 'MLA', _count: { id: 40 } },
        ]),
        findMany: jest.fn().mockResolvedValue([{ snapshot_date: snapshot }]),
      },
      category: { count: jest.fn().mockResolvedValue(30) },
      seller: { count: jest.fn().mockResolvedValue(12) },
    } as any;

    const result = await new StatsService(prisma).getStats();

    expect(result).toEqual({
      total_products: 100,
      total_categories: 30,
      total_sellers: 12,
      latest_snapshot: snapshot,
      by_country: [
        { country: 'MLC', count: 60 },
        { country: 'MLA', count: 40 },
      ],
      snapshot_dates: [snapshot],
    });
  });

  it('returns null latest_snapshot when there are no products', async () => {
    const prisma = {
      product: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      category: { count: jest.fn().mockResolvedValue(0) },
      seller: { count: jest.fn().mockResolvedValue(0) },
    } as any;

    const result = await new StatsService(prisma).getStats();
    expect(result.latest_snapshot).toBeNull();
    expect(result.by_country).toEqual([]);
  });
});
