import pLimit from 'p-limit';
import { DecodoAccountError } from './scraper-health.service';
import { MlScraperService } from './ml-scraper.service';

/** Builds a fake Decodo HTTP response for the global fetch mock. */
function decodoResponse(opts: {
  status?: number;
  targetStatus?: number | null;
  content?: string;
}) {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      results: [{ content: opts.content ?? '', status_code: opts.targetStatus ?? 200 }],
    }),
    text: async () => '',
  };
}

const BIG = 'x'.repeat(60_000);
const SMALL = 'x'.repeat(100);

const CATEGORY_HTML =
  '<li class="ui-search-layout__item">' +
  '<a class="poly-component__title" href="https://www.mercadolibre.cl/p1/p/MLC111">P1</a>' +
  '<span class="andes-money-amount__fraction">1.000</span></li>' +
  BIG;

const PRODUCT_HTML = '"reviews":{"rating":4.8,"amount":50}' + BIG;

function urlOf(call: any[]): string {
  return JSON.parse(call[1].body).url as string;
}

function makeService(overrides: Partial<any> = {}) {
  const config = {
    decodoApiToken: 'token',
    decodoRateLimitPerSec: 1000,
    scraperRetryPartialRender: true,
    ...overrides,
  } as any;
  const health = {
    assertOpen: jest.fn(),
    reportSuccess: jest.fn(),
    reportFailure: jest.fn(),
    reset: jest.fn(),
    getState: jest.fn(() => ({
      consecutiveFailures: 0,
      tripped: false,
      threshold: 10,
      lastDumpDir: null,
    })),
  } as any;
  const slot = pLimit(10);
  const service = new MlScraperService(config, slot, health);
  return { service, health };
}

describe('MlScraperService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it('returns empty without issuing a request when the token is missing', async () => {
    const { service } = makeService({ decodoApiToken: '' });
    const res = await service.scrapeCategoryWithProducts('MLC', 'MLC1');
    expect(res.products).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips sites without a best-sellers section before any request', async () => {
    const { service } = makeService();
    const res = await service.scrapeCategoryWithProducts('MLV', 'MLV1');
    expect(res.products).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a 4xx target status on the category page as "no más-vendidos page"', async () => {
    const { service } = makeService();
    fetchMock.mockResolvedValue(decodoResponse({ targetStatus: 404, content: SMALL }));
    const res = await service.scrapeCategoryWithProducts('MLC', 'MLC1');
    expect(res.products).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a partial render once and gives up returning 0 products', async () => {
    const { service } = makeService();
    // Both attempts come back too small → partial render, no products.
    fetchMock.mockResolvedValue(decodoResponse({ targetStatus: 200, content: SMALL }));
    const res = await service.scrapeCategoryWithProducts('MLC', 'MLC1');
    expect(res.products).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('scrapes a category and enriches its product pages', async () => {
    const { service } = makeService();
    fetchMock.mockImplementation((_url: string, opts: any) => {
      const target = JSON.parse(opts.body).url as string;
      if (target.includes('/mas-vendidos/')) {
        return Promise.resolve(decodoResponse({ content: CATEGORY_HTML }));
      }
      return Promise.resolve(decodoResponse({ content: PRODUCT_HTML }));
    });

    const res = await service.scrapeCategoryWithProducts('MLC', 'MLC1', 4);

    expect(res.products).toHaveLength(1);
    expect(res.products[0].name).toBe('P1');
    const enrichment = res.enrichmentsByUrl.get('https://www.mercadolibre.cl/p1/p/MLC111');
    expect(enrichment?.rating).toBe(4.8);
    expect(enrichment?.review_count).toBe(50);
  });

  it('sends the premium pool + geo + wait chain in the request body', async () => {
    const { service } = makeService();
    fetchMock.mockResolvedValue(decodoResponse({ targetStatus: 404, content: SMALL }));
    await service.scrapeCategoryWithProducts('MLC', 'MLC1');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.proxy_pool).toBe('premium');
    expect(body.headless).toBe('html');
    expect(body.geo).toBe('cl');
    expect(body.browser_actions.map((a: any) => a.type)).toEqual([
      'wait',
      'scroll_to_bottom',
      'wait_for_element',
    ]);
    expect(urlOf(fetchMock.mock.calls[0])).toContain('/mas-vendidos/MLC1');
  });

  it('aborts the run on an account-level Decodo error (402)', async () => {
    const { service } = makeService();
    fetchMock.mockResolvedValue(decodoResponse({ status: 402 }));
    await expect(service.scrapeCategoryWithProducts('MLC', 'MLC1')).rejects.toBeInstanceOf(
      DecodoAccountError,
    );
  });
});
