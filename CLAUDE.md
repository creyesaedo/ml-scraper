# CLAUDE.md — ml-scraper (worker)

This file guides Claude Code when working in this repository.

`ml-scraper` is a **stateless scraping worker**. It performs all fetching —
Decodo web scraping + the MercadoLibre official API + FX rates + holidays — and
returns persist-ready data over HTTP. **It owns no database.** Persistence and
orchestration live in the sibling [`ml-service`](../ml-service) project, which
is the only caller of this worker.

```
ml-service (DB owner) ──HTTP──> ml-scraper (this, worker) ──> Decodo / ML API / FX / holidays
```

## Commands

```bash
# Install dependencies (no package-lock.json — use npm install, not npm ci)
npm install

# Run in development (watch)
npm run start:dev

# Build for production / run the built worker
npm run build
npm start                  # listens on PORT (default 8001)

# Run with Docker (worker only — no database)
docker-compose up

# Tests
npm test
```

No Prisma, no `DATABASE_URL`, no CLI. Configure `.env` from `.env.example`
(Decodo token, ML OAuth creds, `DECODO_RATE_LIMIT_PER_SEC`, `PORT`).

## HTTP endpoints (internal — called by ml-service)

| Method / Route | Returns | Backed by |
|---|---|---|
| `POST /scrape/category/:siteId/:categoryId` | `{ products: EnrichedProduct[] }` | `CategoryFetchService.fetchEnrichedCategory` |
| `POST /scrape/product` (body `{ url, siteId? }`) | `EnrichedProduct` | `CategoryFetchService.fetchProduct` (siteId inferred from URL if omitted) |
| `GET /scrape/probe/:siteId/:categoryId` | `{ verdict }` (`has_products`/`empty`/`no_page`/`failed`) | `MlScraperService.probeCategoryBestSellers` |
| `GET /ml/sites` | `[{ id, name }]` (ML official API) | `MercadoLibreClient.getSites` |
| `GET /ml/categories/:siteId` | `[{ id, name }]` root categories (ML official API) | `MercadoLibreClient.getSiteCategories` |
| `GET /health` | `{ status: 'ok' }` | — |

A **run-level abort** is translated to HTTP `503` with a structured body so
ml-service can classify and stop/resume:

```json
{ "error": "scraper_abort", "reason": "decodo_account" | "circuit_breaker",
  "message": "...", "consecutive_failures": 0, "threshold": 10, "diagnostics_dir": null }
```

`reason` is `circuit_breaker` (consecutive hard failures) or `decodo_account`
(Decodo `401`/`402`/`403`). The `database` abort reason does **not** exist here —
the worker has no DB; that one lives in ml-service.

## The `EnrichedProduct` contract

`src/worker/enriched-product.dto.ts` is the contract between the worker and
ml-service. It is the union of everything the old monolith assembled before
writing a snapshot row:

- listing basics (`name`, `price`, `product_url`, `ranking_position`)
- catalog identity (`catalog_id`, `ml_public_id`, `date_created` via ML API)
- product-page enrichment (`sold_count`, `rating`, `review_count`, `brand`,
  `original_price`, `discount_pct`, `shipping_type`, `listing_type_id`,
  `is_cbt`, `available_quantity`, installments, seller fields)
- FX (`currency`, `exchange_rate`, `usd_price`, `usd_original_price`) — computed
  in the worker from the site's currency and the USD rate
- `holiday_name` for the scrape date in the site's country
- `leaf_category_ml_id` + `leaf_category_name` — the worker resolves the leaf
  category NAME via the ML API so ml-service only maps it to a DB id (no extra
  API call on the DB side)

A **copy** of this type lives in `ml-service/src/adapters/scraper-client/` — keep
the two in sync. `EnrichedProduct` is leaf-category-id-free on purpose: turning
`leaf_category_ml_id` into a DB id (and creating the row) is ml-service's job.

## Architecture (`src/`)

- `worker/` — the HTTP surface.
  - `scraper.controller.ts` — `ScraperController`, the 6 routes above; translates `ScraperAbortError` → HTTP 503.
  - `category-fetch.service.ts` — `CategoryFetchService`. The "fetch + enrich" pipeline: scrape a category (or one product), then enrich each via ML API (`date_created`, leaf name), FX, and holidays, returning `EnrichedProduct[]`. **No DB.**
  - `worker.module.ts`, `enriched-product.dto.ts`.
- `adapters/scraper/` — Decodo scraping.
  - `ml-scraper.service.ts` — `MlScraperService`. HTTP-only against Decodo; rate limiter + circuit breaker + semaphore. Public: `scrapeCategoryWithProducts`, `scrapeProductEnriched`, `probeCategoryBestSellers`.
  - `ml-parsers.ts` — pure functions (`parseCategoryHtml`, `parseProductPageHtml`, `parseSellerFromHtml`, `parseProductBasicsFromHtml`) + types/constants (`ScrapedProduct`, `ProductEnrichment`, `EMPTY_ENRICHMENT`, `SITE_DOMAINS`, `SITE_GEO`, `SITE_CURRENCIES`, `currencyForSite`, `siteIdFromUrl`, `categoryUrl`).
  - `scraper-health.service.ts` — `ScraperHealthService` (circuit breaker), `ScraperAbortError`, `CircuitBreakerOpenError`, `DecodoAccountError`.
  - `scraper-semaphore.provider.ts` — process-wide concurrency cap (`SCRAPER_SEMAPHORE`).
- `adapters/mercadolibre/` — `MercadoLibreClient` (OAuth2 `client_credentials`; `getSites`, `getSiteCategories`, `getCategory`, `getCatalogProduct`).
- `adapters/exchange/` — `ExchangeRateClient` (USD rates, cached per day).
- `adapters/holidays/` — `HolidaysClient` (Nager.Date, cached per year/country).
- `config/app.config.ts` — worker config only (Decodo, ML creds, rate limits, failure threshold). No DB/sync/snapshot keys.

### Decodo request shape

HTTP-only — no headless browser runs in our container. For each URL (category and
product alike) the service POSTs to `https://scraper-api.decodo.com/v2/scrape`:

```json
{
  "url": "...",
  "proxy_pool": "premium",
  "headless": "html",
  "geo": "cl",
  "browser_actions": [
    { "type": "wait", "wait_time_s": 4 },
    { "type": "scroll_to_bottom", "timeout_s": 3 },
    { "type": "wait_for_element",
      "selector": { "type": "css", "value": "li.ui-search-layout__item OR .ui-pdp-price" },
      "timeout_s": 15, "on_error": "skip" }
  ]
}
```

**Why this exact configuration:**

- `proxy_pool: standard` returns `status_code: 613` ("not able to scrape") for ML — Decodo's standard pool cannot pass the PoW challenge. Premium is the only viable pool.
- `headless: html` without JS rendering returns the PoW challenge page (~5–11 KB). ML's anti-bot validates TLS fingerprint, HTTP/2 frame ordering, and the runtime `window.snoopy.track('/anubis')` JS signal — only Decodo's premium + headless solver passes.
- `browser_actions` chain works around a Decodo-side bug: ML pages use streaming SSR (React Server Components). Decodo's renderer sometimes captures HTML before all chunks arrive, returning only the `<head>` (~5–11 KB) with a 200 status. The chain forces (a) a hard 4 s pause for streaming to complete, (b) `scroll_to_bottom` to trigger lazy-hydration sections, (c) `wait_for_element` to verify the price block is in the DOM. Validated at 100 % success across two verticals; without it, 5–10 % came back head-only.

### Billing-aware retries & circuit breaker

**Rate limiter:** sliding-window, capped at `DECODO_RATE_LIMIT_PER_SEC` (default 10, the Free/$19 ceiling). Transient Decodo responses get an **exponential backoff** retry in `postScrapeInner` (`DECODO_RETRY_BACKOFF_BASE_MS` · 2^attempt, capped 30 s):
- Decodo `400` bursts **and** `5xx` retry up to `DECODO_TRANSIENT_MAX_RETRIES` (default 10). `5xx`/`524`/`613` are **not billed** (free to retry); `400` is a `4xx` and **bills when the body is non-empty**.
- HTTP `429` (rate cap) keeps a **single** retry — the limiter is the real guard.
- Network errors (DNS/TCP/TLS) keep a **single** retry.
- Account errors (`401`/`402`/`403`) are permanent → `DecodoAccountError` on the first occurrence.

**Render-failure retry (free):** a `target_status` `613`/`5xx` inside a 200 envelope is a transient render failure, retried up to `RENDER_FAILURE_MAX_RETRIES` (2) at no cost. **Partial-render retry (billed):** a 200 with HTML <50 KB (head-only streaming-SSR race) is retried **once** (`SCRAPER_RETRY_PARTIAL_RENDER`); if still partial → `EMPTY_ENRICHMENT`. Genuine `4xx` (404/410 = no /mas-vendidos page) is **never** retried.

**Circuit breaker (`ScraperHealthService`):** tracks **consecutive hard failures** (a request still carrying an `error` after its retry budget, or target `613`/`5xx`). NOT a hard failure: <50 KB partial renders, no-`catalog_id` pages, expected target `4xx`. At `SCRAPER_FAILURE_THRESHOLD` (default 10) it sets `tripped`, dumps diagnostics to `${SCRAPER_FAILURE_DUMP_DIR}/{ISO}/` (`error.log`, `sample.html`, `context.json`), and `assertOpen()` throws `CircuitBreakerOpenError`. A single success resets the counter. **The breaker is reset at the start of each `fetchEnrichedCategory` / `fetchProduct` call** (each category fetch is an independent unit now).

`CircuitBreakerOpenError` and `DecodoAccountError` both extend `ScraperAbortError`; `MlScraperService` re-throws them (rather than degrading to `EMPTY_ENRICHMENT`), they bubble out of `CategoryFetchService`, and `ScraperController` turns them into the HTTP 503 `scraper_abort` body above.

### Shared parsers (`ml-parsers.ts`)
- `parseCategoryHtml(html)` — cheerio extracts `li.ui-search-layout__item` → `ScrapedProduct[]`.
- `parseProductPageHtml(html)` — regex extracts `sold_count` ("+X mil/millón vendidos"), `rating`, `review_count`, `brand`, `date_created`, `catalogProductId`, `categoryId`, price/discount, shipping, installments, seller from inline `<script>` JSON.
- `parseProductBasicsFromHtml(html)` — `h1.ui-pdp-title` + first `.andes-money-amount__fraction` (name/price for the single-product endpoint).
- `parseSellerFromHtml(html)` — multi-pattern fallback for seller fields.
- `categoryUrl(siteId, categoryMlId)` — best-sellers URL via `SITE_DOMAINS` + `SITE_BESTSELLER_SLUG` (`/mas-vendidos/{id}`, `/mais-vendidos/{id}` for Brazil).
- `siteIdFromUrl(url)` — reverse-lookup siteId from a product URL domain.

**Language support (es + pt).** Most fields read language-agnostic inline JSON keys. The text-based patterns are bilingual: `sold_count`/`seller_total_sales` accept es "mil/millón/millones" **and** pt "mil/milhão/milhões"; "ventas"/"vendas"; "producto(s)"/"produto(s)"; "Envío gratis"/"Frete grátis"; "Tienda oficial"/"Loja oficial". Only Brazil (MLB) is Portuguese.

## Known limitations (scraping)

- **Products without catalog page** (`/up/` URLs): no `catalog_id`, enrichment mostly null. Name and price still captured.
- **Categories without "más vendidos"** (vehicles, real estate, services): genuine `4xx` → 0 products, logged, not a hard failure. **`613`/`5xx` is NOT "no page"** — it is a transient render failure (retried for free; if it still fails, 0 products for that run only, category NOT blacklisted). `probeCategoryBestSellers` mirrors this: `613`/`5xx` → `failed` (never `no_page`).
- **Variable product count per category (0–20):** a best-sellers page lists *at most* 20 — fewer, 1, or 0 are all valid. Never padded.
- **Per-site best-sellers slug:** Spanish `/mas-vendidos`, Brazil `/mais-vendidos`.
- **Markets with no best-sellers (MLD, MLV):** classifieds-only; `SITES_WITHOUT_BESTSELLERS` in `ml-parsers.ts` skips them before any billed request.
- **ML Search API blocked** (403) and **sold_quantity not in API** — scraping is the only source.
- **Decodo head-only / streaming-SSR race:** see the `browser_actions` chain + partial-render retry above.

## Concurrency cap

A single `p-limit(SCRAPER_MAX_CONCURRENT)` in `ScraperModule` gates every outbound request. **Auto-sized** from `DECODO_RATE_LIMIT_PER_SEC` via Little's law (`rate × DECODO_AVG_REQUEST_SECONDS`, ~375 at 25 req/s × 15 s) so the pool is exactly big enough to saturate the plan rate. The rate limiter is the precise pacer. The operator's single knob is `DECODO_RATE_LIMIT_PER_SEC`; set `SCRAPER_MAX_CONCURRENT` only to impose a manual hard ceiling.

## Relevant settings (`src/config/app.config.ts`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8001` | Worker HTTP port |
| `ML_CLIENT_ID` / `ML_CLIENT_SECRET` | `""` | MercadoLibre OAuth2 creds |
| `ML_BASE_URL` | `https://api.mercadolibre.com` | ML API base URL |
| `DECODO_API_TOKEN` | `""` | Decodo Web Scraping API token (base64). Required. |
| `DECODO_RATE_LIMIT_PER_SEC` | `10` | Plan req/s cap: Free/$19=10, $49=25, $99=50, $249=100, $499=150, $999+=200 |
| `DECODO_TRANSIENT_MAX_RETRIES` | `10` | Retries for transient `400`/`5xx`. `429`/network keep a single retry; account errors never retried |
| `DECODO_RETRY_BACKOFF_BASE_MS` | `3000` | Exponential backoff base (`base · 2^attempt`, capped 30 s) |
| `SCRAPER_MAX_CONCURRENT` | *auto* (`rate × DECODO_AVG_REQUEST_SECONDS`) | Global in-flight pool. Leave unset |
| `DECODO_AVG_REQUEST_SECONDS` | `15` | Seconds a request holds a slot (auto-concurrency calc only) |
| `PRODUCT_CONCURRENCY` | *auto* (`= pool`) | Product pages in flight per category fetch |
| `SCRAPER_FAILURE_THRESHOLD` | `10` | Consecutive hard failures before the breaker trips |
| `SCRAPER_FAILURE_DUMP_DIR` | `tmp/scraper-failures` | Where the breaker dumps diagnostics |
| `SCRAPER_RETRY_PARTIAL_RENDER` | `true` | Retry once on a <50 KB partial render |

## Code conventions

- **Everything in English**: all identifiers in English, no exceptions.

## Tool usage

- **Context7 for new technologies**: consult up-to-date docs via the context7 MCP before integrating a new library/service.
