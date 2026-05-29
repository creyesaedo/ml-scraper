import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import pLimit from 'p-limit';
import appConfig from '../../config/app.config';
import {
  EMPTY_ENRICHMENT,
  ProductEnrichment,
  ScrapedProduct,
  SITE_GEO,
  categoryUrl,
  parseCategoryHtml,
  parseProductPageHtml,
} from './ml-parsers';
import {
  CircuitBreakerOpenError,
  ScraperHealthService,
} from './scraper-health.service';
import { SCRAPER_SEMAPHORE, ScraperSlot } from './scraper-semaphore.provider';

const BRIGHTDATA_ENDPOINT = 'https://api.brightdata.com/request';

const PROGRESS_BAR_WIDTH = 24;

function progressBar(completed: number, total: number): string {
  if (total <= 0) return '[' + ' '.repeat(PROGRESS_BAR_WIDTH) + ']';
  const filled = Math.min(
    PROGRESS_BAR_WIDTH,
    Math.round((completed / total) * PROGRESS_BAR_WIDTH),
  );
  return `[${'='.repeat(filled)}${' '.repeat(PROGRESS_BAR_WIDTH - filled)}]`;
}

// HTML size below which a response is treated as a partial/head-only render.
// Real ML pages are 400 KB+; head-only responses (the streaming-SSR race) land
// around 5–11 KB; a fully-failed render returns an empty body.
const PARTIAL_PAGE_THRESHOLD = 50_000;

// CSS selectors the x-unblock-expect header waits for before Web Unlocker returns
// the HTML. ML uses streaming SSR — without this wait, the renderer can capture
// the page mid-stream with only <head> populated.
const CATEGORY_EXPECT_SELECTOR = 'li.ui-search-layout__item';
const PRODUCT_EXPECT_SELECTOR = '.ui-pdp-price';

interface BrdScrapeResult {
  content: string;
  // Outer HTTP status from the Bright Data API (0 = network error before a response).
  httpStatus: number;
  // The TARGET page's HTTP status, surfaced by Bright Data in the x-brd-status-code
  // response header (the outer status stays 200). 404 here means the URL does not
  // exist — e.g. a category with no /mas-vendidos page. Null when not reported.
  targetStatus: number | null;
  // Bright Data surfaces target/proxy-side failures via the x-brd-err-code header
  // even when the outer HTTP status is 200 (e.g. client_10050 = IP not allowed in
  // the zone). Null when the request was clean.
  brdErrCode: string | null;
  // Billed requests this result took (hybrid retry can make it 2).
  attempts: number;
  // True when the plain (no-expect) fallback produced this result.
  retriedPlain?: boolean;
  error?: string;
}

/**
 * MercadoLibre scraper backed by Bright Data Web Unlocker (REST API). POSTs to
 * `api.brightdata.com/request` with `format: raw`; JS rendering is automatic.
 *
 * Hybrid render strategy (validated at 100% on MLC1648):
 *   1. Attempt with the `x-unblock-expect` header → Web Unlocker waits until the
 *      selector is present. This fixes ML's head-only streaming-SSR responses,
 *      but the header has a fixed ~25–30 s internal timeout that returns a
 *      0-byte 200 on slower pages (heavy CBT/"Internacional" listings take 27–44 s).
 *   2. If that comes back below PARTIAL_PAGE_THRESHOLD with no hard error (the
 *      expect-timeout signature), retry once WITHOUT the header so Web Unlocker
 *      waits for the full auto-render with no premature cutoff.
 * Category pages need step 1 (plain returns head-only); slow product pages need
 * step 2. ~10% of pages trigger the retry.
 *
 * Sliding-window rate limiter caps starts at `scraperRateLimitPerSec`; network
 * errors and HTTP 429 each get a single free retry inside one request attempt.
 *
 * BILLING NOTE: enabling a custom feature (x-unblock-expect) makes Bright Data
 * bill every request — successful and failed alike — so the plain retry is billed.
 */
@Injectable()
export class MlScraperService {
  private readonly logger = new Logger(MlScraperService.name);
  private readonly rateLimiter: { acquire: () => Promise<void> };

  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
    @Inject(SCRAPER_SEMAPHORE)
    private readonly slot: ScraperSlot,
    private readonly health: ScraperHealthService,
  ) {
    this.rateLimiter = this.createRateLimiter(this.config.scraperRateLimitPerSec);
  }

  async scrapeCategoryWithProducts(
    siteId: string,
    categoryMlId: string,
    productConcurrency = 8,
  ): Promise<{
    products: ScrapedProduct[];
    enrichmentsByUrl: Map<string, ProductEnrichment>;
  }> {
    const enrichmentsByUrl = new Map<string, ProductEnrichment>();

    if (!this.config.brightdataApiToken) {
      this.logger.error('BRIGHTDATA_API_TOKEN is not configured');
      return { products: [], enrichmentsByUrl };
    }

    const url = categoryUrl(siteId, categoryMlId);

    // Step 1: category page
    const catRes = await this.scrape(url, siteId, CATEGORY_EXPECT_SELECTOR);
    if (catRes.error) {
      this.logger.error(`[${siteId}] Error scraping category ${categoryMlId}: ${catRes.error}`);
      return { products: [], enrichmentsByUrl };
    }
    // A 4xx from the target (typically 404) means this category has no
    // /mas-vendidos page — a known, expected case, not a render failure.
    if (catRes.targetStatus && catRes.targetStatus >= 400) {
      this.logger.warn(
        `[${siteId}] Category ${categoryMlId} has no /mas-vendidos page ` +
          `(HTTP ${catRes.targetStatus} at ${url}) — skipping, 0 products`,
      );
      return { products: [], enrichmentsByUrl };
    }
    if (catRes.content.length < PARTIAL_PAGE_THRESHOLD) {
      this.logger.warn(
        `[${siteId}] Category page too small (${catRes.content.length}b) for ${categoryMlId} — likely partial render`,
      );
      return { products: [], enrichmentsByUrl };
    }

    const products = parseCategoryHtml(catRes.content);
    if (!products.length) {
      this.logger.warn(`[${siteId}] No products found for ${categoryMlId}`);
      return { products, enrichmentsByUrl };
    }
    // Step 2: product pages in parallel (still bounded by rate limiter)
    const total = products.length;
    const productPagesStart = Date.now();
    const limit = pLimit(productConcurrency);
    let completed = 0;
    // Emit ~5 progress updates per category regardless of size (1 update for
    // small categories, every Nth for large ones). Final update always logs
    // with elapsed time.
    const step = Math.max(1, Math.floor(total / 5));
    await Promise.all(
      products.map((p) =>
        limit(async () => {
          if (!p.product_url) return;
          const enrichment = await this.scrapeProductPage(p.product_url, siteId);
          enrichmentsByUrl.set(p.product_url, enrichment);
          completed += 1;
          const isFinal = completed === total;
          if (completed % step === 0 || isFinal) {
            const bar = progressBar(completed, total);
            const suffix = isFinal
              ? ` (${((Date.now() - productPagesStart) / 1000).toFixed(1)}s)`
              : '';
            this.logger.log(
              `[${siteId}] Scraping ${total} products for ${categoryMlId} ${bar} ${completed}/${total}${suffix}`,
            );
          }
        }),
      ),
    );

    return { products, enrichmentsByUrl };
  }

  private async scrapeProductPage(
    productUrl: string,
    siteId: string,
  ): Promise<ProductEnrichment> {
    let res: BrdScrapeResult;
    try {
      res = await this.scrape(productUrl, siteId, PRODUCT_EXPECT_SELECTOR);
    } catch (err) {
      // CircuitBreakerOpenError MUST propagate so the whole sync aborts.
      // Anything else is a soft per-product failure.
      if (err instanceof CircuitBreakerOpenError) throw err;
      this.logger.warn(`Unexpected error scraping ${productUrl}: ${(err as Error).message}`);
      return EMPTY_ENRICHMENT;
    }
    if (res.error) {
      this.logger.warn(`Error scraping product page ${productUrl}: ${res.error}`);
      return EMPTY_ENRICHMENT;
    }
    if (res.content.length < PARTIAL_PAGE_THRESHOLD) {
      this.logger.warn(`Product page too small (${res.content.length}b): ${productUrl}`);
      return EMPTY_ENRICHMENT;
    }
    return parseProductPageHtml(res.content);
  }

  /**
   * Runs the hybrid render strategy for one URL inside the global concurrency
   * semaphore, then reports the final outcome to the circuit breaker.
   *
   * Hard failures (network error, BD HTTP error, or a BD x-brd-err-code on the
   * response) increment the consecutive-failure counter; a clean response (even
   * a small head-only one) resets it. When the counter hits the threshold,
   * reportFailure() throws CircuitBreakerOpenError which propagates out and
   * aborts the sync. Head-only/partial renders are NOT hard failures — they fall
   * through to EMPTY_ENRICHMENT in the caller.
   */
  private async scrape(
    url: string,
    siteId: string,
    expectSelector: string,
  ): Promise<BrdScrapeResult> {
    return this.slot(async () => {
      this.health.assertOpen();

      // Attempt 1: with x-unblock-expect.
      let result = await this.requestOnce(url, siteId, expectSelector, false);

      // The expect-timeout signature: clean response (no hard error) but body
      // below threshold. Retry plain so Web Unlocker waits for the full render.
      // Skip the retry on a 4xx target (e.g. 404 = no /mas-vendidos page) — the
      // page genuinely doesn't exist, so a retry would just burn a billed request.
      const softEmpty =
        !result.error &&
        !result.brdErrCode &&
        !(result.targetStatus !== null && result.targetStatus >= 400) &&
        result.content.length < PARTIAL_PAGE_THRESHOLD;
      if (softEmpty) {
        const plain = await this.requestOnce(url, siteId, null, false);
        result = {
          ...plain,
          attempts: result.attempts + plain.attempts,
          retriedPlain: true,
        };
      }

      if (this.isHardFailure(result)) {
        await this.health.reportFailure(
          {
            timestamp: new Date().toISOString(),
            url,
            siteId,
            status: result.httpStatus,
            errorMessage: result.error ?? `x-brd-err-code=${result.brdErrCode}`,
          },
          result.content || undefined,
        );
      } else {
        this.health.reportSuccess();
      }

      return result;
    });
  }

  private isHardFailure(result: BrdScrapeResult): boolean {
    // Network error or any non-2xx from the BD API → hard.
    // A BD x-brd-err-code on a 200 (IP not allowed, proxy/render failure) → hard.
    // A clean 200 with a small body (head-only) is NOT hard — soft, returns EMPTY.
    return Boolean(result.error) || Boolean(result.brdErrCode);
  }

  /**
   * One Bright Data Web Unlocker request. When `expectSelector` is set, the
   * x-unblock-expect header makes BD wait for that selector (with its fixed
   * internal timeout); when null, BD auto-renders with no premature cutoff.
   *
   * `format: raw` returns the target page's HTML as the response body. BD
   * surfaces target/proxy errors via the x-brd-err-code response header even on
   * a 200, so we always read it. Network errors and HTTP 429 each get one free
   * retry (not billed — the request never produced a scrape).
   */
  private async requestOnce(
    url: string,
    siteId: string,
    expectSelector: string | null,
    retried: boolean,
  ): Promise<BrdScrapeResult> {
    await this.rateLimiter.acquire();

    const body: Record<string, unknown> = {
      zone: this.config.brightdataZone,
      url,
      format: 'raw',
      country: SITE_GEO[siteId] ?? 'ar',
    };
    if (expectSelector) {
      // The header value is itself a JSON string: {"element": "<css>"}.
      body.headers = {
        'x-unblock-expect': JSON.stringify({ element: expectSelector }),
      };
    }

    let res: Response;
    try {
      res = await fetch(BRIGHTDATA_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.brightdataApiToken}`,
        },
        body: JSON.stringify(body),
      });
      if (retried) {
        this.logger.log(`Bright Data retry succeeded for ${url}`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      const cause = (err as Error & { cause?: { code?: string } }).cause?.code;
      const causeStr = cause ? ` (cause: ${cause})` : '';
      // Transient network error (DNS, TCP reset, TLS glitch) — the request never
      // reached Bright Data, so a retry is free. Single retry; a second failure
      // is treated as a real outage and fed to the breaker.
      if (!retried) {
        this.logger.warn(
          `Bright Data fetch failed for ${url}${causeStr}: ${msg} — retrying in 1s`,
        );
        await sleep(1000);
        return this.requestOnce(url, siteId, expectSelector, true);
      }
      this.logger.error(
        `Bright Data fetch failed for ${url}${causeStr}: ${msg} — giving up after retry`,
      );
      return {
        content: '',
        httpStatus: 0,
        targetStatus: null,
        brdErrCode: null,
        attempts: 1,
        error: `network: ${msg}${causeStr}`,
      };
    }

    // 429 = plan/zone rate cap; back off briefly and retry once.
    if (res.status === 429 && !retried) {
      await sleep(1000);
      return this.requestOnce(url, siteId, expectSelector, true);
    }

    const brdErrCode = res.headers.get('x-brd-err-code');
    const targetStatusHeader = res.headers.get('x-brd-status-code');
    const targetStatus = targetStatusHeader ? parseInt(targetStatusHeader, 10) : null;
    const content = await res.text().catch(() => '');

    if (!res.ok) {
      return {
        content: '',
        httpStatus: res.status,
        targetStatus,
        brdErrCode,
        attempts: 1,
        error: `brightdata http ${res.status}: ${content.slice(0, 200)}`,
      };
    }

    return { content, httpStatus: res.status, targetStatus, brdErrCode, attempts: 1 };
  }

  /**
   * Sliding-window limiter: at most `perSec` request starts in any 1000 ms window.
   * Callers `await acquire()` before sending; it blocks until a slot frees up.
   */
  private createRateLimiter(perSec: number): { acquire: () => Promise<void> } {
    const starts: number[] = [];
    return {
      async acquire() {
        while (true) {
          const now = Date.now();
          while (starts.length && now - starts[0] >= 1000) starts.shift();
          if (starts.length < perSec) {
            starts.push(now);
            return;
          }
          await sleep(1000 - (now - starts[0]) + 1);
        }
      },
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
