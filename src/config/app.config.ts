import { registerAs } from '@nestjs/config';

export interface AppConfig {
  mlClientId: string;
  mlClientSecret: string;
  mlBaseUrl: string;
  decodoApiToken: string;
  decodoRateLimitPerSec: number;
  decodoTransientMaxRetries: number;
  decodoRetryBackoffBaseMs: number;
  decodoRequestTimeoutMs: number;
  decodoGeoOverrides: Record<string, string>;
  scraperMaxConcurrent: number;
  productConcurrency: number;
  scraperAdaptiveConcurrency: boolean;
  scraperMinConcurrent: number;
  scraperInitialConcurrent: number;
  scraperConcurrencyIncreaseStep: number;
  scraperConcurrencyDecreaseFactor: number;
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

    // ── Adaptive (AIMD) concurrency ─────────────────────────────────────────
    // Because Decodo's per-request latency is variable and unbounded, a fixed
    // pool is always mis-sized. With adaptive mode ON (default) the in-flight
    // window self-tunes: it starts near the plan rate and ramps UP on sustained
    // success, then backs OFF multiplicatively on hard failures so a struggling
    // backend (notably MCO) gets its queue drained instead of flooded.
    // scraperMaxConcurrent is reused as the hard ceiling. Set
    // SCRAPER_ADAPTIVE_CONCURRENCY=false to fall back to the fixed pool.
    const scraperAdaptiveConcurrency = process.env.SCRAPER_ADAPTIVE_CONCURRENCY !== 'false';
    const scraperMinConcurrent = Math.max(
      1,
      parseInt(process.env.SCRAPER_MIN_CONCURRENT ?? '4', 10),
    );
    // Start near the plan's req/s — enough to make progress without a thundering
    // herd of heavy renders on the first wave; AIMD ramps it up from there.
    const scraperInitialConcurrent = process.env.SCRAPER_INITIAL_CONCURRENT
      ? Math.max(scraperMinConcurrent, parseInt(process.env.SCRAPER_INITIAL_CONCURRENT, 10))
      : Math.min(scraperMaxConcurrent, Math.max(scraperMinConcurrent, decodoRateLimitPerSec));

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
      // Hard per-attempt timeout for a single Decodo /v2/scrape call. Node's
      // fetch otherwise leans on undici's ~300 s default, so a stuck render
      // (notably MCO) wastes ~5 min and comes back as an unclassifiable client
      // disconnect. A tighter ceiling turns it into a clean network failure that
      // is retried promptly and, after the budget, feeds the AIMD decrease arm.
      // Set ABOVE the worst legit single call — Decodo's own internal render
      // retry loop has been observed at ~132 s — so we only cut genuine hangs,
      // not slow-but-real renders. Default 180 s. Per-attempt — retries get fresh.
      decodoRequestTimeoutMs: Math.max(
        1000,
        parseInt(process.env.DECODO_REQUEST_TIMEOUT_MS ?? '180000', 10),
      ),
      // Per-site proxy-exit geo overrides, "SITE:geo" pairs (e.g. "MCO:br").
      // Some Decodo country pools render MercadoLibre badly: MCO ('co', Colombia)
      // hangs/fails and burns long retry loops, while routing the SAME .com.co
      // pages through 'br' renders them first-try (A/B verified: 38/38 vs 34/38,
      // 0 retries vs many, 79 s vs 301 s). The page data is identical — the
      // domain serves Colombian content regardless of the proxy's exit country.
      // Default ships the known MCO->br fix; override via env to re-tune.
      decodoGeoOverrides: parseGeoOverrides(process.env.DECODO_GEO_OVERRIDES ?? 'MCO:br'),
      scraperMaxConcurrent,
      productConcurrency,
      scraperAdaptiveConcurrency,
      scraperMinConcurrent,
      scraperInitialConcurrent,
      // Slots added per saturated success (additive increase). Default 1.
      scraperConcurrencyIncreaseStep: Math.max(
        1,
        parseInt(process.env.SCRAPER_CONCURRENCY_INCREASE_STEP ?? '1', 10),
      ),
      // Window multiplier on a hard failure (multiplicative decrease). Default
      // 0.8 — gentle enough to avoid oscillation, fast enough to drain a backlog.
      scraperConcurrencyDecreaseFactor: clampFloat(
        parseFloat(process.env.SCRAPER_CONCURRENCY_DECREASE_FACTOR ?? '0.8'),
        0.1,
        0.99,
      ),
      scraperFailureThreshold: Math.max(1, parseInt(process.env.SCRAPER_FAILURE_THRESHOLD ?? '10', 10)),
      scraperFailureDumpDir: process.env.SCRAPER_FAILURE_DUMP_DIR ?? 'tmp/scraper-failures',
      // Retry a page once when Decodo returns a partial render (200 but body
      // too small). Defaults to enabled; set to "false" to opt out and save the
      // extra billed request at the cost of more null-enrichment rows.
      scraperRetryPartialRender: process.env.SCRAPER_RETRY_PARTIAL_RENDER !== 'false',
    };
  },
);

/** Parses a float env value, falling back to a clamped sane range. */
function clampFloat(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return hi;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Parses a "SITE:geo,SITE:geo" env string into a { SITE: geo } map. Site ids are
 * upper-cased (MCO), geo codes lower-cased (br). Malformed pairs are skipped.
 */
function parseGeoOverrides(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [site, geo] = pair.split(':').map((s) => s.trim());
    if (site && geo) map[site.toUpperCase()] = geo.toLowerCase();
  }
  return map;
}
