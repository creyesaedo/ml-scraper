import { Body, Controller, Get, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import { MercadoLibreClient } from '../adapters/mercadolibre/mercadolibre.client';
import { MlScraperService } from '../adapters/scraper/ml-scraper.service';
import {
  DecodoAccountError,
  ScraperAbortError,
  ScraperHealthService,
} from '../adapters/scraper/scraper-health.service';
import { CategoryFetchService } from './category-fetch.service';
import { EnrichedProduct, ProbeVerdict } from './enriched-product.dto';

interface ScrapeProductBody {
  url: string;
  siteId?: string;
}

/**
 * HTTP surface of the scraper worker. It performs all fetching (Decodo + ML API
 * + FX + holidays) and returns persist-ready data; it owns no database. Only
 * ml-service calls these endpoints. Run-level scraper aborts are translated to
 * HTTP 503 with a structured body so ml-service can classify and stop/resume.
 */
@Controller()
export class ScraperController {
  constructor(
    private readonly fetchService: CategoryFetchService,
    private readonly scraper: MlScraperService,
    private readonly mlClient: MercadoLibreClient,
    private readonly health: ScraperHealthService,
  ) {}

  /** Current adaptive-concurrency window (limit / in-flight / queued) for diagnostics. */
  @Get('scrape/gate')
  gateStats(): { limit: number; inFlight: number; queued: number } {
    return this.scraper.getConcurrencyStats();
  }

  /** One full category enriched (best-sellers + product pages + ML API/FX/holidays). */
  @Post('scrape/category/:siteId/:categoryId')
  async scrapeCategory(
    @Param('siteId') siteId: string,
    @Param('categoryId') categoryId: string,
  ): Promise<{ products: EnrichedProduct[] }> {
    return this.runOrAbort(async () => ({
      products: await this.fetchService.fetchEnrichedCategory(siteId.toUpperCase(), categoryId),
    }));
  }

  /** One product page enriched (no persistence — used by the preview endpoint). */
  @Post('scrape/product')
  async scrapeProduct(@Body() body: ScrapeProductBody): Promise<EnrichedProduct> {
    if (!body?.url) {
      throw new HttpException('Body must include a "url"', HttpStatus.BAD_REQUEST);
    }
    return this.runOrAbort(() => this.fetchService.fetchProduct(body.url, body.siteId));
  }

  /** Best-sellers probe verdict for a category (category page only, no products). */
  @Get('scrape/probe/:siteId/:categoryId')
  async probe(
    @Param('siteId') siteId: string,
    @Param('categoryId') categoryId: string,
  ): Promise<{ verdict: ProbeVerdict }> {
    return this.runOrAbort(async () => ({
      verdict: await this.scraper.probeCategoryBestSellers(siteId.toUpperCase(), categoryId),
    }));
  }

  /** Every MercadoLibre site (ML official API), for category sync. */
  @Get('ml/sites')
  getSites(): Promise<Array<{ id: string; name: string }>> {
    return this.mlClient.getSites();
  }

  /** Root categories for a site (ML official API), for category sync. */
  @Get('ml/categories/:siteId')
  getSiteCategories(
    @Param('siteId') siteId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    return this.mlClient.getSiteCategories(siteId.toUpperCase());
  }

  /**
   * Runs a scraper operation, translating a run-level abort (circuit breaker or
   * Decodo account error) into HTTP 503 with `{ error, reason, ... }` so
   * ml-service can stop the run with the right reason and resume later.
   */
  private async runOrAbort<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof ScraperAbortError) {
        const reason = err instanceof DecodoAccountError ? 'decodo_account' : 'circuit_breaker';
        const state = this.health.getState();
        throw new HttpException(
          {
            error: 'scraper_abort',
            reason,
            message: err.message,
            consecutive_failures: state.consecutiveFailures,
            threshold: state.threshold,
            diagnostics_dir: state.lastDumpDir,
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw err;
    }
  }
}
