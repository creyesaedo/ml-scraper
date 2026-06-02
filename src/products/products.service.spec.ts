import { BadRequestException } from '@nestjs/common';
import { ProductsService } from './products.service';

function makeService() {
  const prisma = {
    product: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    catalogProduct: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  return { service: new ProductsService(prisma), prisma };
}

describe('ProductsService', () => {
  describe('findPaginated', () => {
    it('builds an AND filter, applies skip/take and computes total_pages', async () => {
      const { service, prisma } = makeService();
      prisma.product.findMany.mockResolvedValue([{ id: 1 }]);
      prisma.product.count.mockResolvedValue(25);

      const res = await service.findPaginated({
        page: 2,
        limit: 10,
        country: 'MLC',
        category_id: 5,
        search: 'phone',
      });

      const args = prisma.product.findMany.mock.calls[0][0];
      expect(args.skip).toBe(10);
      expect(args.take).toBe(10);
      expect(args.where).toMatchObject({
        country: 'MLC',
        category_id: 5,
        name: { contains: 'phone', mode: 'insensitive' },
      });
      expect(res.meta).toEqual({ total: 25, page: 2, limit: 10, total_pages: 3 });
    });

    it('builds a date range filter', async () => {
      const { service, prisma } = makeService();
      await service.findPaginated({ page: 1, limit: 10, date_from: '2026-01-01', date_to: '2026-02-01' });
      const where = prisma.product.findMany.mock.calls[0][0].where;
      expect(where.snapshot_date.gte).toEqual(new Date('2026-01-01'));
      expect(where.snapshot_date.lte).toEqual(new Date('2026-02-01'));
    });
  });

  describe('findCatalogProducts', () => {
    it('rejects searches shorter than 2 characters', async () => {
      const { service } = makeService();
      await expect(service.findCatalogProducts('a')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('searches name and brand for valid input', async () => {
      const { service, prisma } = makeService();
      await service.findCatalogProducts('  drill  ');
      const where = prisma.catalogProduct.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { name: { contains: 'drill', mode: 'insensitive' } },
        { brand: { contains: 'drill', mode: 'insensitive' } },
      ]);
    });
  });

  describe('findPriceHistory', () => {
    it('rejects when neither identifier is provided', async () => {
      const { service } = makeService();
      await expect(service.findPriceHistory({})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when both identifiers are provided', async () => {
      const { service } = makeService();
      await expect(
        service.findPriceHistory({ ml_public_id: '1', catalog_id: 'MLC1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('queries by ml_public_id ascending', async () => {
      const { service, prisma } = makeService();
      await service.findPriceHistory({ ml_public_id: '123' });
      const args = prisma.product.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ ml_public_id: '123' });
      expect(args.orderBy).toEqual({ snapshot_date: 'asc' });
    });

    it('queries by catalog_id', async () => {
      const { service, prisma } = makeService();
      await service.findPriceHistory({ catalog_id: 'MLC9' });
      expect(prisma.product.findMany.mock.calls[0][0].where).toEqual({ catalog_id: 'MLC9' });
    });
  });
});
