import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CategoryResponseDto } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lists categories ordered by id, optionally filtered to one country and/or
   * to root categories only (parentOnly = those with no parent).
   */
  async findAll(country?: string, parentOnly?: boolean): Promise<CategoryResponseDto[]> {
    return this.prisma.category.findMany({
      where: {
        ...(country ? { country } : {}),
        ...(parentOnly ? { parent_id: null } : {}),
      },
      orderBy: { id: 'asc' },
    });
  }
}
