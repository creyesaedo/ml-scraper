import { Prisma } from '../../generated/prisma/client';

type Decimal = Prisma.Decimal;

export class ProductResponseDto {
  id: number;
  name: string;
  price: Decimal;
  country: string | null;
  category_id: number;
  parent_id: number | null;
  snapshot_date: Date;
  catalog_id: string | null;
  listing_id: string | null;
  date_created: Date | null;
  sold_count: number | null;
  rating: Decimal | null;
  review_count: number | null;
  brand: string | null;
}
