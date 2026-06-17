import { registerAs } from '@nestjs/config';

export interface AppConfig {
  mlClientId: string;
  mlClientSecret: string;
  mlBaseUrl: string;
  decodoApiToken: string;
  decodoRateLimitPerSec: number;
  decodoTransientMaxRetries: number;
  decodoRetryBackoffBaseMs: number;
  scraperMaxConcurrent: number;
  productConcurrency: number;
  scraperFailureThreshold: number;
  scraperFailureDumpDir: string;
  scraperRetryPartialRender: boolean;
}

/**
 * Worker configuration — only what the scraping/fetching layer needs. There is
 * no database, sync schedule, or snapshot scope here; those belong to ml-service.
 */
export default registerAs(
  'app',
  (): AppConfig => {
    // ── Auto-sized scraper concurrency ──────────────────────────────────────
    // The single knob the operator sets is DECODO_RATE_LIMIT_PER_SEC (the plan's
    // req/s cap). Everything below auto-derives from it so concurrency never has
    // to be hand-tuned. The rate limiter remains the precise pacer; the pool just
    // has to be big enough to *reach* that rate.
    //
    // Little's law: to sustain `rate` request-starts/s when each request occupies
    // a slot for `seconds`, you need `rate × seconds` requests in flight. At 25
    // req/s × ~15 s that's ~375 — NOT 25. A pool capped at 25 would only yield
    // ~25/15 ≈ 1.7 req/s and leave the plan almost unused.
    const decodoRateLimitPerSec = Math.max(1, parseInt(process.env.DECODO_RATE_LIMIT_PER_SEC ?? '10', 10));
    // Avg seconds a Decodo request holds a slot (4 s wait + scroll + render, plus
    // it stays held through internal retries). Tune via env only if your observed
    // per-request latency differs a lot from the ~14–15 s default.
    const decodoSecondsPerRequest = Math.max(1, parseInt(process.env.DECODO_AVG_REQUEST_SECONDS ?? '15', 10));
    // Global in-flight pool. Auto = rate × seconds (saturates the rate limit).
    // SCRAPER_MAX_CONCURRENT, when set, overrides the auto value as a hard ceiling.
    const autoConcurrency = Math.ceil(decodoRateLimitPerSec * decodoSecondsPerRequest);
    const scraperMaxConcurrent = process.env.SCRAPER_MAX_CONCURRENT
      ? Math.max(1, parseInt(process.env.SCRAPER_MAX_CONCURRENT, 10))
      : autoConcurrency;
    // Product pages flow freely into the global pool (no inner throttle below it).
    const productConcurrency = process.env.PRODUCT_CONCURRENCY
      ? Math.max(1, parseInt(process.env.PRODUCT_CONCURRENCY, 10))
      : scraperMaxConcurrent;

    return {
      mlClientId: process.env.ML_CLIENT_ID ?? '',
      mlClientSecret: process.env.ML_CLIENT_SECRET ?? '',
      mlBaseUrl: process.env.ML_BASE_URL ?? 'https://api.mercadolibre.com',
      decodoApiToken: process.env.DECODO_API_TOKEN ?? '',
      decodoRateLimitPerSec,
      // How many times to retry a transient Decodo-side soft failure — HTTP 400
      // "Something went wrong. Please try again later" bursts. These are NOT
      // billed (status: "failed"), so retrying is free; default 10 to ride out
      // the multi-second bursts seen in the field (notably MCO). 5xx gateway
      // errors are capped at a single retry separately so the circuit breaker
      // still trips promptly on a real outage.
      decodoTransientMaxRetries: Math.max(
        0,
        parseInt(process.env.DECODO_TRANSIENT_MAX_RETRIES ?? '10', 10),
      ),
      // Base delay for the exponential backoff between transient-failure retries:
      // baseMs, 2×, 4×, … (capped in the scraper). Default 3 s.
      decodoRetryBackoffBaseMs: Math.max(
        0,
        parseInt(process.env.DECODO_RETRY_BACKOFF_BASE_MS ?? '3000', 10),
      ),
      scraperMaxConcurrent,
      productConcurrency,
      scraperFailureThreshold: Math.max(1, parseInt(process.env.SCRAPER_FAILURE_THRESHOLD ?? '10', 10)),
      scraperFailureDumpDir: process.env.SCRAPER_FAILURE_DUMP_DIR ?? 'tmp/scraper-failures',
      // Retry a page once when Decodo returns a partial render (200 but body
      // too small). Defaults to enabled; set to "false" to opt out and save the
      // extra billed request at the cost of more null-enrichment rows.
      scraperRetryPartialRender: process.env.SCRAPER_RETRY_PARTIAL_RENDER !== 'false',
    };
  },
);
