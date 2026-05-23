import { Injectable } from '@nestjs/common';
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
}
