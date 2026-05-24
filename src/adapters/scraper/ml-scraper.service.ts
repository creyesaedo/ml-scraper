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

const DECODO_ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';

// HTML size below which a response is treated as a partial/challenge page.
// Real ML pages are 400 KB+; head-only responses (the Decodo SSR streaming bug)
// land around 5–11 KB.
const PARTIAL_PAGE_THRESHOLD = 50_000;

// CSS selectors Decodo's headless waits for before returning the HTML.
// ML uses streaming SSR — without these waits, the renderer sometimes
// captures the page mid-stream with only <head> populated.
const CATEGORY_WAIT_SELECTOR = 'li.ui-search-layout__item';
const PRODUCT_WAIT_SELECTOR = '.ui-pdp-price';

type DecodoActions = Array<
  | { type: 'wait'; wait_time_s: number }
  | { type: 'scroll_to_bottom'; timeout_s: number }
  | {
      type: 'wait_for_element';
      selector: { type: 'css'; value: string };
      timeout_s: number;
    }
>;

interface DecodoScrapeResult {
  content: string;
  targetStatus: number | null;
  decodoStatus: number;
  error?: string;
}

/**
 * MercadoLibre scraper. POSTs to Decodo's /v2/scrape with `proxy_pool: premium`
 * and `headless: html` (only combination that bypasses ML's anti-bot). To work
 * around Decodo's headless cutting off mid-render on streaming SSR pages, every
 * request chains `wait` → `scroll_to_bottom` → `wait_for_element`.
 *
 * Sliding-window rate limiter caps starts at `decodoRateLimitPerSec`; 429
 * responses get a single 1-second backoff retry (not billed).
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
    this.rateLimiter = this.createRateLimiter(this.config.decodoRateLimitPerSec);
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

    if (!this.config.decodoApiToken) {
      this.logger.error('DECODO_API_TOKEN is not configured');
      return { products: [], enrichmentsByUrl };
    }

    const url = categoryUrl(siteId, categoryMlId);

    // Step 1: category page
    const catRes = await this.scrapeWithWait(url, siteId, CATEGORY_WAIT_SELECTOR);
    if (catRes.error) {
      this.logger.error(`[${siteId}] Error scraping category ${categoryMlId}: ${catRes.error}`);
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
    this.logger.log(`[${siteId}] ${categoryMlId} → ${products.length} products`);

    // Step 2: product pages in parallel (still bounded by rate limiter)
    const limit = pLimit(productConcurrency);
    await Promise.all(
      products.map((p) =>
        limit(async () => {
          if (!p.product_url) return;
          const enrichment = await this.scrapeProductPage(p.product_url, siteId);
          enrichmentsByUrl.set(p.product_url, enrichment);
        }),
      ),
    );

    return { products, enrichmentsByUrl };
  }

  private async scrapeProductPage(
    productUrl: string,
    siteId: string,
  ): Promise<ProductEnrichment> {
    let res: DecodoScrapeResult;
    try {
      res = await this.scrapeWithWait(productUrl, siteId, PRODUCT_WAIT_SELECTOR);
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
   * Issues one POST to Decodo with the browser_actions chain that handles ML's
   * streaming SSR. Returns the rendered HTML or an error description.
   */
  private async scrapeWithWait(
    url: string,
    siteId: string,
    waitSelector: string,
  ): Promise<DecodoScrapeResult> {
    const body = {
      url,
      proxy_pool: 'premium',
      headless: 'html',
      geo: SITE_GEO[siteId] ?? 'ar',
      browser_actions: [
        { type: 'wait', wait_time_s: 4 },
        { type: 'scroll_to_bottom', timeout_s: 3 },
        {
          type: 'wait_for_element',
          selector: { type: 'css', value: waitSelector },
          timeout_s: 8,
        },
      ] satisfies DecodoActions,
    };

    return this.postScrape(body);
  }

  /**
   * Wraps the actual HTTP call in the global concurrency semaphore and reports
   * outcome to the circuit breaker. Hard failures (network error, HTTP 5xx,
   * Decodo target_status 5xx/613) increment the consecutive-failure counter;
   * any 2xx response (even partial renders) resets it. When the counter hits
   * SCRAPER_FAILURE_THRESHOLD, reportFailure() throws CircuitBreakerOpenError
   * which propagates out and aborts the sync.
   */
  private async postScrape(body: Record<string, unknown>): Promise<DecodoScrapeResult> {
    return this.slot(async () => {
      this.health.assertOpen();
      const result = await this.postScrapeInner(body, false);

      const targetStatus = result.targetStatus;
      const isHardFailure =
        // network error
        (result.error?.startsWith('network:') ?? false) ||
        // Decodo gateway error (rare)
        result.decodoStatus >= 500 ||
        // Decodo "failed to scrape" — not billed per Decodo docs
        targetStatus === 613 ||
        // upstream 5xx from ML through Decodo
        (typeof targetStatus === 'number' && targetStatus >= 500 && targetStatus < 600);

      if (isHardFailure) {
        await this.health.reportFailure(
          {
            timestamp: new Date().toISOString(),
            url: String(body.url ?? ''),
            status: targetStatus,
            errorMessage: result.error ?? `target_status=${targetStatus}`,
          },
          result.content || undefined,
        );
      } else {
        this.health.reportSuccess();
      }

      return result;
    });
  }

  private async postScrapeInner(
    body: Record<string, unknown>,
    retried: boolean,
  ): Promise<DecodoScrapeResult> {
    await this.rateLimiter.acquire();

    const targetUrl = String(body.url ?? '<unknown>');
    let res: Response;
    try {
      res = await fetch(DECODO_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Basic ${this.config.decodoApiToken}`,
        },
        body: JSON.stringify(body),
      });
      if (retried) {
        this.logger.log(`Decodo retry succeeded for ${targetUrl}`);
      }
    } catch (err) {
      const msg = (err as Error).message;
      const cause = (err as Error & { cause?: { code?: string } }).cause?.code;
      const causeStr = cause ? ` (cause: ${cause})` : '';
      // Transient network error (DNS hiccup, TCP reset, TLS handshake glitch).
      // The request never reached Decodo, so a retry is free. Single retry —
      // a second failure indicates a real outage and gets fed to the breaker.
      if (!retried) {
        this.logger.warn(
          `Decodo fetch failed for ${targetUrl}${causeStr}: ${msg} — retrying in 1s`,
        );
        await sleep(1000);
        return this.postScrapeInner(body, true);
      }
      this.logger.error(
        `Decodo fetch failed for ${targetUrl}${causeStr}: ${msg} — giving up after retry`,
      );
      return {
        content: '',
        targetStatus: null,
        decodoStatus: 0,
        error: `network: ${msg}${causeStr}`,
      };
    }

    // 429 = plan rate cap; backoff briefly and retry once. Not billed.
    if (res.status === 429 && !retried) {
      await sleep(1000);
      return this.postScrapeInner(body, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        content: '',
        targetStatus: null,
        decodoStatus: res.status,
        error: `decodo http ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const json = (await res.json().catch(() => ({}))) as {
      results?: Array<{ content?: string; status_code?: number }>;
    };
    const result = json.results?.[0] ?? {};
    return {
      content: result.content ?? '',
      targetStatus: result.status_code ?? null,
      decodoStatus: res.status,
    };
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
