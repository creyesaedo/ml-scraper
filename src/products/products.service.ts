import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(categoryId?: number) {
    return this.prisma.product.findMany({
      where: categoryId !== undefined ? { category_id: categoryId } : undefined,
      orderBy: [{ snapshot_date: 'desc' }, { id: 'asc' }],
    });
  }

  async findPaginated(params: {
    page: number;
    limit: number;
    country?: string;
    category_id?: number;
    date_from?: string;
    date_to?: string;
    search?: string;
  }) {
    const { page, limit, country, category_id, date_from, date_to, search } = params;
    const skip = (page - 1) * limit;

    const where = {
      ...(country && { country }),
      ...(category_id && { category_id }),
      ...((date_from || date_to) && {
        snapshot_date: {
          ...(date_from && { gte: new Date(date_from) }),
          ...(date_to && { lte: new Date(date_to) }),
        },
      }),
      ...(search && {
        name: { contains: search, mode: 'insensitive' as const },
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ snapshot_date: 'desc' }, { ranking_position: 'asc' }],
        select: {
          id: true,
          name: true,
          price: true,
          original_price: true,
          discount_pct: true,
          country: true,
          snapshot_date: true,
          ranking_position: true,
          sold_count: true,
          rating: true,
          review_count: true,
          brand: true,
          ml_public_id: true,
          catalog_id: true,
          shipping_type: true,
          is_cbt: true,
          category: { select: { name: true, ml_id: true } },
          seller: { select: { nickname: true, is_official_store: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
      },
    };
  }

  async findCatalogProducts(search: string) {
    if (!search || search.trim().length < 2) {
      throw new BadRequestException('search must be at least 2 characters');
    }
    return this.prisma.catalogProduct.findMany({
      where: {
        OR: [
          { name: { contains: search.trim(), mode: 'insensitive' } },
          { brand: { contains: search.trim(), mode: 'insensitive' } },
        ],
      },
      select: {
        catalog_id: true,
        name: true,
        brand: true,
        first_seen_at: true,
        last_seen_at: true,
      },
      orderBy: { name: 'asc' },
      take: 20,
    });
  }

  async findPriceHistory(params: { ml_public_id?: string; catalog_id?: string }) {
    const { ml_public_id, catalog_id } = params;

    if (!ml_public_id && !catalog_id) {
      throw new BadRequestException('Provide ml_public_id or catalog_id');
    }
    if (ml_public_id && catalog_id) {
      throw new BadRequestException('Provide only one of ml_public_id or catalog_id, not both');
    }

    const where = ml_public_id ? { ml_public_id } : { catalog_id };

    return this.prisma.product.findMany({
      where,
      orderBy: { snapshot_date: 'asc' },
      select: {
        snapshot_date: true,
        price: true,
        original_price: true,
        ranking_position: true,
        sold_count: true,
        ml_public_id: true,
        catalog_id: true,
      },
    });
  }
}
