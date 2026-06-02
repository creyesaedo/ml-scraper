// Throwaway: show enrichment for products saved in today's MLC1168 run, to
// confirm the pipeline populated real data (not nulls). Delete after use.
require('dotenv').config();
const { PrismaClient } = require('../dist/generated/prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

(async () => {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const rows = await prisma.product.findMany({
    where: { country: 'MLC', snapshot_date: { gte: start } },
    orderBy: { ranking_position: 'asc' },
    select: {
      ranking_position: true, name: true, price: true, sold_count: true,
      rating: true, review_count: true, brand: true, seller_id: true,
      catalog_id: true, category_id: true, parent_id: true,
    },
  });
  const enriched = rows.filter((r) => r.sold_count !== null || r.rating !== null);
  console.log(`saved today: ${rows.length} | with sold_count/rating: ${enriched.length}\n`);
  for (const r of rows) {
    console.log(
      `#${String(r.ranking_position).padStart(2)} ${r.name.slice(0, 38).padEnd(38)} ` +
      `$${String(r.price).padStart(7)} sold=${String(r.sold_count ?? '-').padStart(7)} ` +
      `rating=${r.rating ?? '-'} reviews=${r.review_count ?? '-'} brand=${r.brand ?? '-'} ` +
      `seller=${r.seller_id ?? '-'} cat=${r.category_id}/${r.parent_id ?? '-'}`,
    );
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
