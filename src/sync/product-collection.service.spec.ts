import { EMPTY_ENRICHMENT } from '../adapters/scraper/ml-parsers';
import { DecodoAccountError } from '../adapters/scraper/scraper-health.service';
import { Prisma } from '../generated/prisma/client';
import { ProductCollectionService } from './product-collection.service';

function makePrisma() {
  return {
    category: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    syncProgress: {
      createMany: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    product: { createMany: jest.fn().mockResolvedValue({}) },
    seller: { upsert: jest.fn() },
    catalogProduct: { upsert: jest.fn().mockResolvedValue({}) },
  } as any;
}

function makeConfig(overrides: Record<string, any> = {}) {
  const values: Record<string, any> = {
    'app.snapshotCategoriesBySite': {},
    'app.snapshotCategoryLimit': null,
    'app.appMode': 'PRODUCTION',
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as any;
}

function makeService(prisma: any, configService: any) {
  const scraper = { scrapeCategoryWithProducts: jest.fn() } as any;
  const mlClient = { getCatalogProduct: jest.fn(), getCategory: jest.fn() } as any;
  const holidays = { getHolidayName: jest.fn().mockResolvedValue(null) } as any;
  const health = {
    reset: jest.fn(),
    getState: jest.fn(() => ({
      consecutiveFailures: 0,
      tripped: false,
      threshold: 10,
      lastDumpDir: null,
    })),
  } as any;
  const service = new ProductCollectionService(
    prisma,
    scraper,
    mlClient,
    holidays,
    configService,
    health,
  );
  return { service, scraper, mlClient, holidays, health };
}

const product = {
  name: 'P1',
  price: '1000',
  catalog_id: null,
  product_url: 'https://ml/p/1',
  ranking_position: 1,
};

describe('ProductCollectionService', () => {
  it('returns an error when the site has no categories', async () => {
    const prisma = makePrisma();
    const { service } = makeService(prisma, makeConfig());
    const result = await service.collect('MLC');
    expect(result.productos_guardados).toBe(0);
    expect(result.errores![0]).toContain('No categories found');
  });

  it('aborts (throws) in DEVELOPMENT mode when no whitelist is set', async () => {
    const prisma = makePrisma();
    prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1', name: 'A' }]);
    const config = makeConfig({ 'app.appMode': 'DEVELOPMENT' });
    const { service } = makeService(prisma, config);
    await expect(service.collect('MLC')).rejects.toThrow(/DEVELOPMENT mode requires a whitelist/);
  });

  it('scrapes, enriches and inserts product snapshots (happy path)', async () => {
    const prisma = makePrisma();
    prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1', name: 'A' }]);
    const { service, scraper } = makeService(prisma, makeConfig());
    scraper.scrapeCategoryWithProducts.mockResolvedValue({
      products: [product],
      enrichmentsByUrl: new Map([[product.product_url, { ...EMPTY_ENRICHMENT }]]),
    });

    const result = await service.collect('MLC');

    expect(result.productos_guardados).toBe(1);
    expect(result.categorias_procesadas).toBe(1);
    expect(result.aborted).toBeUndefined();
    expect(prisma.product.createMany).toHaveBeenCalledTimes(1);
    const inserted = prisma.product.createMany.mock.calls[0][0].data;
    expect(inserted[0]).toMatchObject({ name: 'P1', price: '1000', category_id: 1, parent_id: null });
  });

  it('aborts with reason decodo_account when the scraper throws DecodoAccountError', async () => {
    const prisma = makePrisma();
    prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1', name: 'A' }]);
    const { service, scraper } = makeService(prisma, makeConfig());
    scraper.scrapeCategoryWithProducts.mockRejectedValue(new DecodoAccountError(402, 'no balance'));

    const result = await service.collect('MLC');

    expect(result.aborted?.reason).toBe('decodo_account');
    expect(result.aborted?.pending_categories).toContain('MLC1');
    expect(prisma.product.createMany).not.toHaveBeenCalled();
  });

  it('aborts with reason database when an insert hits a Prisma init error', async () => {
    const prisma = makePrisma();
    prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1', name: 'A' }]);
    prisma.product.createMany.mockRejectedValue(
      new Prisma.PrismaClientInitializationError('db down', '7.0.0'),
    );
    const { service, scraper } = makeService(prisma, makeConfig());
    scraper.scrapeCategoryWithProducts.mockResolvedValue({
      products: [product],
      enrichmentsByUrl: new Map([[product.product_url, { ...EMPTY_ENRICHMENT }]]),
    });

    const result = await service.collect('MLC');

    expect(result.aborted?.reason).toBe('database');
  });

  it('records a category with no results in errores and marks it done', async () => {
    const prisma = makePrisma();
    prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1', name: 'A' }]);
    const { service, scraper } = makeService(prisma, makeConfig());
    scraper.scrapeCategoryWithProducts.mockResolvedValue({
      products: [],
      enrichmentsByUrl: new Map(),
    });

    const result = await service.collect('MLC');

    expect(result.productos_guardados).toBe(0);
    expect(result.categorias_procesadas).toBe(1);
    expect(result.errores).toContain('MLC1: sin resultados');
  });
});
