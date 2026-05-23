import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CategoryResponseDto } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(country?: string): Promise<CategoryResponseDto[]> {
    return this.prisma.category.findMany({
      where: country ? { country } : undefined,
      orderBy: { id: 'asc' },
    });
  }
}
