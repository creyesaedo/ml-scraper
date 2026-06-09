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
  siteHasBestSellers,
} from './ml-parsers';
import {
  DecodoAccountError,
  ScraperAbortError,
  ScraperHealthService,
} from './scraper-health.service';
import { SCRAPER_SEMAPHORE, ScraperSlot } from './scraper-semaphore.provider';

const DECODO_ENDPOINT = 'https://scraper-api.decodo.com/v2/scrape';

const PROGRESS_BAR_WIDTH = 24;

function progressBar(completed: number, total: number): string {
  if (total <= 0) return '[' + ' '.repeat(PROGRESS_BAR_WIDTH) + ']';
  const filled = Math.min(
    PROGRESS_BAR_WIDTH,
    Math.round((completed / total) * PROGRESS_BAR_WIDTH),
  );
  return `[${'='.repeat(filled)}${' '.repeat(PROGRESS_BAR_WIDTH - filled)}]`;
}

// HTML size below which a response is treated as a partial/challenge page.
// Real ML pages are 400 KB+; head-only responses (the Decodo SSR streaming bug)
// land around 5–11 KB.
const PARTIAL_PAGE_THRESHOLD = 50_000;

// CSS selectors Decodo's headless waits for before returning the HTML.
// ML uses streaming SSR — without these waits, the renderer sometimes
// captures the page mid-stream with only <head> populated.
const CATEGORY_WAIT_SELECTOR = 'li.ui-search-layout__item';
const PRODUCT_WAIT_SELECTOR = '.ui-pdp-price';

// Ceiling for how long Decodo waits for the target element before returning the
// HTML it has. wait_for_element exits as soon as the element appears, so raising
// this only gives slow renders more room — healthy pages are unaffected, and
// Decodo bills per request (not per second), so a higher value costs nothing.
// Raised from 8s after observing ML's streaming SSR sometimes needs longer than
// 8s to paint the price/listing block (it rendered fully at 15s in testing).
const WAIT_FOR_ELEMENT_TIMEOUT_S = 15;

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

    // MercadoLibre runs a reduced marketplace in a few markets (MLD, MLV) with no
    // best-sellers section — every /mas-vendidos URL 404s. Skip them before
    // issuing any billed request; they would only return 0 products.
    if (!siteHasBestSellers(siteId)) {
      this.logger.warn(
        `[${siteId}] Site has no best-sellers section — skipping ${categoryMlId} (0 products, no request issued)`,
      );
      return { products: [], enrichmentsByUrl };
    }

    const url = categoryUrl(siteId, categoryMlId);

    // Step 1: category page
    const catRes = await this.scrapeWithWait(url, siteId, CATEGORY_WAIT_SELECTOR);
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

  /**
   * Lightweight check of whether a category has a usable /mas-vendidos page,
   * issuing ONLY the category-page request (never the 20 product pages). Used by
   * the category-sync probe phase to flag dead categories so the collector can
   * skip them. Reuses the same render chain + partial-render retry as a real
   * scrape, so the verdict matches what collection would have seen.
   *
   *   'has_products' — ranking present (1+ products rendered)
   *   'empty'        — page rendered fully (200, ≥50 KB) but 0 products
   *                    (soft-404 / no ranking / auth-gated like some Perú verticals)
   *   'no_page'      — target returned HTTP ≥400, or the site has no best-sellers
   *   'failed'       — network/Decodo error or partial render (inconclusive — the
   *                    caller should NOT mark the category, so a glitch never
   *                    blacklists a category)
   *
   * Run-level aborts (circuit breaker, Decodo account error) propagate as usual.
   */
  async probeCategoryBestSellers(
    siteId: string,
    categoryMlId: string,
  ): Promise<'has_products' | 'empty' | 'no_page' | 'failed'> {
    if (!this.config.decodoApiToken) {
      this.logger.error('DECODO_API_TOKEN is not configured');
      return 'failed';
    }
    if (!siteHasBestSellers(siteId)) return 'no_page';

    const url = categoryUrl(siteId, categoryMlId);
    const res = await this.scrapeWithWait(url, siteId, CATEGORY_WAIT_SELECTOR);
    if (res.error) return 'failed';
    if (res.targetStatus && res.targetStatus >= 400) return 'no_page';
    if (res.content.length < PARTIAL_PAGE_THRESHOLD) return 'failed';
    return parseCategoryHtml(res.content).length > 0 ? 'has_products' : 'empty';
  }

  private async scrapeProductPage(
    productUrl: string,
    siteId: string,
  ): Promise<ProductEnrichment> {
    let res: DecodoScrapeResult;
    try {
      res = await this.scrapeWithWait(productUrl, siteId, PRODUCT_WAIT_SELECTOR);
    } catch (err) {
      // Run-level aborts (circuit breaker, Decodo account error) MUST propagate
      // so the whole sync stops. Anything else is a soft per-product failure.
      if (err instanceof ScraperAbortError) throw err;
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
   * Issues a Decodo scrape with the browser_actions chain that handles ML's
   * streaming SSR, and retries ONCE when the response comes back as a partial
   * render.
   *
   * A "partial render" is a 200 response whose HTML is below
   * PARTIAL_PAGE_THRESHOLD: Decodo captured the page before ML finished
   * streaming the <body>, so only the <head> arrived. Decodo reports this as a
   * success (status 200), so the small size is the only signal. The data we
   * need lives in the missing body, so a single extra attempt usually recovers
   * it.
   *
   * Only partial renders are retried here. Network errors and HTTP 429 are
   * already retried inside postScrapeInner; hard failures (5xx / 613) and
   * expected 4xx (no /mas-vendidos page) are handled by callers and must NOT be
   * retried, since each retry re-incurs Decodo cost (200s are billed). The retry
   * can be disabled with SCRAPER_RETRY_PARTIAL_RENDER=false.
   */
  private async scrapeWithWait(
    url: string,
    siteId: string,
    waitSelector: string,
  ): Promise<DecodoScrapeResult> {
    const result = await this.postScrape(this.buildScrapeBody(url, siteId, waitSelector));

    if (this.config.scraperRetryPartialRender && this.isPartialRender(result)) {
      this.logger.warn(
        `[${siteId}] Partial render (${result.content.length}b) for ${url} — retrying once`,
      );
      const retry = await this.postScrape(this.buildScrapeBody(url, siteId, waitSelector));
      // Keep the retry only if it actually came back fuller; otherwise return the
      // first result so we never trade a usable response for a worse one.
      return retry.content.length > result.content.length ? retry : result;
    }

    return result;
  }

  /** Builds the Decodo /v2/scrape request body (premium pool + the SSR wait chain). */
  private buildScrapeBody(
    url: string,
    siteId: string,
    waitSelector: string,
  ): Record<string, unknown> {
    return {
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
          timeout_s: WAIT_FOR_ELEMENT_TIMEOUT_S,
        },
      ] satisfies DecodoActions,
    };
  }

  /**
   * True for a partial render: Decodo returned a 200 (no transport error and no
   * 4xx/5xx target status) but the HTML is too small to hold the page body.
   * These are the only responses worth a single retry.
   */
  private isPartialRender(res: DecodoScrapeResult): boolean {
    const targetOk = res.targetStatus === null || res.targetStatus < 400;
    return !res.error && targetOk && res.content.length < PARTIAL_PAGE_THRESHOLD;
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

      // Account-level Decodo failure (out of balance / bad token / forbidden).
      // These are NOT >= 500, so they would otherwise slip past the hard-failure
      // check below and even reset the breaker via reportSuccess(), letting the
      // run grind through every category with empty results. Abort the run now.
      if (isDecodoAccountError(result.decodoStatus)) {
        const msg =
          `Decodo refused the request (HTTP ${result.decodoStatus}) — ` +
          `out of balance or invalid token`;
        this.logger.error(`${msg}. Aborting sync. url=${String(body.url ?? '')}`);
        throw new DecodoAccountError(result.decodoStatus, msg);
      }

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
      // Transient Decodo-side failures — HTTP 400 "Something went wrong. Please
      // try again later" bursts and 5xx gateway errors — clear on a retry.
      // Back off and retry once. Account errors (401/402/403) are permanent and
      // handled by the caller, so they are never retried here.
      if (!retried && !isDecodoAccountError(res.status)) {
        this.logger.warn(
          `Decodo HTTP ${res.status} for ${targetUrl}: ${text.slice(0, 120)} — retrying in 1s`,
        );
        await sleep(1000);
        return this.postScrapeInner(body, true);
      }
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

/**
 * True for Decodo HTTP statuses that signal an account problem rather than a
 * per-request failure: 401 (bad/expired token), 402 (out of balance / payment
 * required), 403 (forbidden). Retrying or scraping other URLs cannot recover
 * from these, so they abort the whole run.
 */
function isDecodoAccountError(decodoStatus: number): boolean {
  return decodoStatus === 401 || decodoStatus === 402 || decodoStatus === 403;
}
