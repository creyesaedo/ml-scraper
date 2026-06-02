import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Paginated product search backing the /products endpoint. All filters
   * (country, category, date range, name search) are optional and combined with
   * AND; only the columns the frontend needs are selected. Runs the page query
   * and the total count together and returns the rows plus pagination metadata.
   */
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

  /**
   * Typeahead-style search over catalog products by name or brand. Requires at
   * least 2 characters and returns up to 20 matches, ordered by name.
   */
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

  /**
   * Returns the snapshot history (price, ranking, units sold over time) for one
   * product, ordered oldest to newest. Identify the product by exactly one of
   * `ml_public_id` (a specific listing) or `catalog_id` (a catalog product);
   * passing none or both is rejected.
   */
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
