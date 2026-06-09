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
    'app.skipKnownEmptyCategories': true,
    ...overrides,
  };
  return { get: jest.fn((key: string) => values[key]) } as any;
}

function makeService(prisma: any, configService: any) {
  const scraper = { scrapeCategoryWithProducts: jest.fn() } as any;
  const mlClient = { getCatalogProduct: jest.fn(), getCategory: jest.fn() } as any;
  const holidays = { getHolidayName: jest.fn().mockResolvedValue(null) } as any;
  const exchangeRates = { getRate: jest.fn().mockResolvedValue(950) } as any;
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
    exchangeRates,
    configService,
    health,
  );
  return { service, scraper, mlClient, holidays, exchangeRates, health };
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
    expect(result.products_saved).toBe(0);
    expect(result.errors![0]).toContain('No categories found');
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

    expect(result.products_saved).toBe(1);
    expect(result.categories_processed).toBe(1);
    expect(result.aborted).toBeUndefined();
    expect(prisma.product.createMany).toHaveBeenCalledTimes(1);
    const inserted = prisma.product.createMany.mock.calls[0][0].data;
    expect(inserted[0]).toMatchObject({
      name: 'P1',
      price: '1000',
      category_id: 1,
      parent_id: null,
      currency: 'CLP',
      exchange_rate: 950,
      usd_price: 1.05, // 1000 / 950, rounded to 2dp
    });
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

  it('retries a transient DB connection blip on insert and still saves', async () => {
    // Make withDbRetry's backoff instant so the test doesn't really sleep.
    const timer = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: any) => {
        fn();
        return 0 as any;
      }) as any);
    try {
      const prisma = makePrisma();
      prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1', name: 'A' }]);
      // First insert hits a transient pooler drop, second one succeeds.
      prisma.product.createMany
        .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
        .mockResolvedValue({});
      const { service, scraper } = makeService(prisma, makeConfig());
      scraper.scrapeCategoryWithProducts.mockResolvedValue({
        products: [product],
        enrichmentsByUrl: new Map([[product.product_url, { ...EMPTY_ENRICHMENT }]]),
      });

      const result = await service.collect('MLC');

      expect(prisma.product.createMany).toHaveBeenCalledTimes(2);
      expect(result.products_saved).toBe(1);
      expect(result.aborted).toBeUndefined();
    } finally {
      timer.mockRestore();
    }
  });

  it('aborts with reason database on a persistent connection error (not just init errors)', async () => {
    const timer = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: any) => {
        fn();
        return 0 as any;
      }) as any);
    try {
      const prisma = makePrisma();
      prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1', name: 'A' }]);
      // A mid-query Neon drop surfaces as a raw connection error, NOT a
      // PrismaClientInitializationError — must still be treated as `database`.
      prisma.product.createMany.mockRejectedValue(
        new Error("Can't reach database server at ep-xyz.neon.tech"),
      );
      const { service, scraper } = makeService(prisma, makeConfig());
      scraper.scrapeCategoryWithProducts.mockResolvedValue({
        products: [product],
        enrichmentsByUrl: new Map([[product.product_url, { ...EMPTY_ENRICHMENT }]]),
      });

      const result = await service.collect('MLC');

      expect(result.aborted?.reason).toBe('database');
    } finally {
      timer.mockRestore();
    }
  });

  it('does not crash when a checkpoint write fails for a soft per-category error', async () => {
    const prisma = makePrisma();
    prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1', name: 'A' }]);
    const { service, scraper } = makeService(prisma, makeConfig());
    // Non-DB scrape failure → soft per-category error path.
    scraper.scrapeCategoryWithProducts.mockRejectedValue(new Error('boom'));
    // The "mark failed" checkpoint write itself fails — must be swallowed, not crash the run.
    prisma.syncProgress.update.mockImplementation((args: any) =>
      args.data.status === 'failed'
        ? Promise.reject(new Error('checkpoint write failed'))
        : Promise.resolve({}),
    );

    const result = await service.collect('MLC');

    expect(result.errors).toContain('MLC1: boom');
    expect(result.aborted).toBeUndefined();
  });

  it('skips categories flagged has_bestsellers=false and scrapes the rest', async () => {
    const prisma = makePrisma();
    prisma.category.findMany.mockResolvedValue([
      { id: 1, ml_id: 'MLC1', name: 'NoRanking', has_bestsellers: false },
      { id: 2, ml_id: 'MLC2', name: 'HasRanking', has_bestsellers: true },
      { id: 3, ml_id: 'MLC3', name: 'Unknown', has_bestsellers: null },
    ]);
    const { service, scraper } = makeService(prisma, makeConfig());
    scraper.scrapeCategoryWithProducts.mockResolvedValue({
      products: [product],
      enrichmentsByUrl: new Map([[product.product_url, { ...EMPTY_ENRICHMENT }]]),
    });

    const result = await service.collect('MLC');

    // MLC1 (false) skipped; MLC2 (true) and MLC3 (null) scraped.
    const scraped = scraper.scrapeCategoryWithProducts.mock.calls.map((c: any[]) => c[1]);
    expect(scraped).toEqual(['MLC2', 'MLC3']);
    expect(scraped).not.toContain('MLC1');
    expect(result.categories_processed).toBe(2);
  });

  it('does not skip flagged categories when skipKnownEmptyCategories is off', async () => {
    const prisma = makePrisma();
    prisma.category.findMany.mockResolvedValue([
      { id: 1, ml_id: 'MLC1', name: 'NoRanking', has_bestsellers: false },
    ]);
    const config = makeConfig({ 'app.skipKnownEmptyCategories': false });
    const { service, scraper } = makeService(prisma, config);
    scraper.scrapeCategoryWithProducts.mockResolvedValue({ products: [], enrichmentsByUrl: new Map() });

    await service.collect('MLC');

    expect(scraper.scrapeCategoryWithProducts).toHaveBeenCalledWith('MLC', 'MLC1', expect.anything());
  });

  it('records a category with no results in errors and marks it done', async () => {
    const prisma = makePrisma();
    prisma.category.findMany.mockResolvedValue([{ id: 1, ml_id: 'MLC1', name: 'A' }]);
    const { service, scraper } = makeService(prisma, makeConfig());
    scraper.scrapeCategoryWithProducts.mockResolvedValue({
      products: [],
      enrichmentsByUrl: new Map(),
    });

    const result = await service.collect('MLC');

    expect(result.products_saved).toBe(0);
    expect(result.categories_processed).toBe(1);
    expect(result.errors).toContain('MLC1: no results');
  });
});
