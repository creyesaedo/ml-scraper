import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Builds the dashboard summary in a single round of parallel queries: total
   * products, categories and sellers, the most recent snapshot date, the
   * product count per country, and the last 52 distinct snapshot dates (about a
   * year of weekly runs).
   */
  async getStats() {
    const [totalProducts, totalCategories, totalSellers, latestSnapshot, byCountry, snapshotDates] =
      await Promise.all([
        this.prisma.product.count(),
        this.prisma.category.count(),
        this.prisma.seller.count(),
        this.prisma.product.findFirst({
          orderBy: { snapshot_date: 'desc' },
          select: { snapshot_date: true },
        }),
        this.prisma.product.groupBy({
          by: ['country'],
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
        }),
        this.prisma.product.findMany({
          distinct: ['snapshot_date'],
          orderBy: { snapshot_date: 'desc' },
          select: { snapshot_date: true },
          take: 52,
        }),
      ]);

    return {
      total_products: totalProducts,
      total_categories: totalCategories,
      total_sellers: totalSellers,
      latest_snapshot: latestSnapshot?.snapshot_date ?? null,
      by_country: byCountry.map((c) => ({ country: c.country, count: c._count.id })),
      snapshot_dates: snapshotDates.map((s) => s.snapshot_date),
    };
  }
}
