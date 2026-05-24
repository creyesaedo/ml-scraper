# GEMINI.md

This file provides guidance to the Gemini coding assistant (such as Antigravity) when working with code in this repository.

## Commands

```bash
# Install dependencies (no package-lock.json — use npm install, not npm ci)
npm install

# Generate Prisma client (required after schema changes)
npx prisma generate

# Run in development (requires PostgreSQL running)
npm run start:dev

# Run everything with Docker (API + PostgreSQL + pgAdmin)
# Schema is applied automatically on container start via prisma db push
docker-compose up

# Apply schema directly to DB (no migration files needed)
npx prisma db push

# Create and apply a versioned migration
npx prisma migrate dev --name description

# Prisma Studio (DB browser)
npx prisma studio

# Build for production
npm run build

# Tests
npm test
```

## Docker setup

Three services defined in `docker-compose.yml`:
- `api` — NestJS app on port `8000`. Runs `prisma db push` before starting.
- `db` — PostgreSQL 16 on port `5432`. The `api` service waits for its healthcheck.
- `pgadmin` — pgAdmin 4 on port `5050` (admin@admin.com / admin).

The `Dockerfile` uses a **multi-stage build**:
- `builder` stage: installs all dependencies (including devDependencies), runs `prisma generate` (emits the client to `src/generated/prisma`), and compiles TypeScript via `nest build`.
- `production` stage: installs only production dependencies (`--omit=dev`), adds OpenSSL (required by Prisma's CLI), re-runs `prisma generate`, and copies `dist/` from the builder.

## Prisma 7

The project uses Prisma 7 with a driver adapter:
- `prisma/schema.prisma` — datasource has NO `url`. The connection string lives in `prisma.config.ts` at the project root (`process.env.DATABASE_URL`).
- Generator is `prisma-client` (not the legacy `prisma-client-js`), outputting to `src/generated/prisma`. It is configured for CommonJS (`moduleFormat = "cjs"`, `importFileExtension = ""`) so it interops with our `module: "commonjs"` tsconfig.
- `PrismaService` extends `PrismaClient` and passes a `PrismaPg` adapter (`@prisma/adapter-pg`) to the constructor — no Prisma native query engine binaries are needed.
- `tsconfig.build.json` excludes `prisma.config.ts` so its presence at the project root does not push tsc's `rootDir` up and shift `dist/main.js` to `dist/src/main.js`.

## Program flow

### Execution triggers

1. **Weekly cron job** (automatic, default: Monday 3 UTC)
   - Configured via `SYNC_DAY_OF_WEEK` and `SYNC_HOUR` in `.env`
   - `WeeklySyncJob` iterates over `SNAPSHOT_SITE_IDS` (comma-separated) and calls `SyncRunnerService.run(siteId)` for each
   - Runs on a fixed schedule, never blocks the API

2. **Manual HTTP endpoint** (on-demand)
   - `POST /sync/run/:siteId` — full cycle (categories + products)
   - For testing/debugging only — production should use the cron job (takes ~13 minutes for 32 parent categories per site)

### Synchronization flow

```
TRIGGER: POST /sync/run/:siteId  OR  weekly cron (WeeklySyncJob)
         │
         ▼
   SyncRunnerService.run(siteId)
         │
         ├─ DB has 0 categories for this site?
         │   └─ YES → CategorySyncService.sync(siteId)
         │               ├─ GET /sites/{siteId}/categories  (ML API, OAuth2)
         │               ├─ UPSERT root categories → categories table
         │               └─ p-limit(8): parallel per root category
         │                   └─ GET /categories/{parent_id} (ML API, OAuth2)
         │                       UPSERT children → categories table (parent_id = root.id)
         │
         └─ ProductCollectionService.collect(siteId)
                 │
                 ├─ SELECT all parent categories FROM categories table
                 │     WHERE parent_id IS NULL AND site_id = siteId
                 │
                 └─ p-limit(3): process 3 categories in parallel
                         │
                         └─ Per category:
                             │
                             ├─ MlScraperService.scrapeCategoryWithProducts(siteId, categoryMlId)
                             │   │
                             │   ├─ POST https://scraper-api.decodo.com/v2/scrape per URL
                             │   │     Body: { url, proxy_pool: 'premium', headless: 'html',
                             │   │             geo: 'cl|ar|br|mx|...',
                             │   │             browser_actions: [
                             │   │               { wait: 4s },
                             │   │               { scroll_to_bottom: 3s },
                             │   │               { wait_for_element: SELECTOR, 8s timeout }
                             │   │             ] }
                             │   │     SELECTOR: 'li.ui-search-layout__item' (category)
                             │   │            or '.ui-pdp-price' (product)
                             │   │   Sliding-window rate limiter (DECODO_RATE_LIMIT_PER_SEC) before
                             │   │   each request; HTTP 429 → 1s backoff + 1 retry (not billed)
                             │   ├─ Step 1: Category page → cheerio → 20 products
                             │   ├─ Step 2: 20 product pages in parallel (p-limit(8))
                             │   │   Page <50KB → treat as partial render → EMPTY_ENRICHMENT
                             │   └─ Returns: { products, enrichmentsByUrl }
                             │
                             ├─ Parallel: MercadoLibreClient.getCatalogProduct() for each product
                             │   ├─ Per product with catalog_id:
                             │   │   └─ GET /products/{catalog_id} (ML API, OAuth2)
                             │   │       Returns: date_created (when product was listed)
                             │   └─ Runs in parallel with scraping via p-limit(8)
                             │
                             ├─ resolveLeafCategory() for each product's leaf category
                             │   ├─ If categoryId (leaf) not in DB:
                             │   │   ├─ GET /categories/{categoryId} (ML API, OAuth2)
                             │   │   └─ UPSERT → categories table (parent_id = root.id, ml_id = categoryId)
                             │   └─ Cached per sync run to avoid duplicate API calls
                             │
                             └─ INSERT product snapshots → products table
                                 ├─ snapshot_date = TODAY
                                 ├─ category_id = leaf category ID (if resolved) or root
                                 ├─ parent_id = root category ID (if leaf found) or NULL
                                 ├─ enrichment fields: sold_count, rating, review_count,
                                 │   brand, date_created, catalog_id, listing_id
                                 └─ Note: immutable rows — same product + same date = new insert
                                     (enables price/ranking history)
```

### HTTP endpoints

#### Health
```http
GET /health
→ 200 OK { "status": "ok" }
```

#### Read
```http
GET /categorias
GET /categorias?solo_padres=true     # only root categories
GET /productos?category_id=<id>      # all snapshots for that category
```

#### Manual sync (on-demand, for testing)
```http
POST /sync/run/:siteId       # full sync: categories (if empty) + products
POST /sync/categorias        # categories only — all ML sites (no siteId param)
POST /sync/productos/:siteId # products only (categories must already exist)
POST /sync/resume/:siteId    # continue the most recent unfinished sync_run for this site
```

When the circuit breaker trips mid-run, `/sync/run` or `/sync/productos` returns 200 with `aborted` populated:

```json
{
  "site_id": "MLC",
  "sync_run_id": "MLC-2026-05-23T03-00-00-000Z",
  "categorias_procesadas": 18,
  "productos_guardados": 360,
  "snapshot_date": "2026-05-23T03:00:00Z",
  "aborted": {
    "reason": "circuit_breaker",
    "consecutive_failures": 10,
    "threshold": 10,
    "diagnostics_dir": "tmp/scraper-failures/2026-05-23T03-22-41-123Z",
    "completed_categories": ["MLC1648", "MLC1512", "..."],
    "pending_categories": ["MLC1574", "MLC1132", "..."]
  }
}
```

## Architecture

**1. Category sync — via MercadoLibre official API.**
`CategorySyncService` uses `MercadoLibreClient` (axios) to fetch the category tree for a site (e.g. `MLC`). It upserts root categories first (via `prisma.category.upsert`) to get their DB IDs, then fetches their children in parallel with `Promise.allSettled` + `pLimit(8)`. Individual subcategory failures are logged and skipped — they do not abort the full sync.

**2. Product collection — via Decodo Web Scraping API.**

`MlScraperService` exposes `scrapeCategoryWithProducts(siteId, categoryMlId, productConcurrency = 8)` returning `{ products: ScrapedProduct[], enrichmentsByUrl: Map<string, ProductEnrichment> }`. The map is keyed by `product_url` so callers can look up enrichment without a second scrape. `EMPTY_ENRICHMENT` is the safe-default value returned when a product URL is missing, the page is <50 KB, or the request errors.

Files in `src/adapters/scraper/`:
- `ml-parsers.ts` — pure functions (`parseCategoryHtml`, `parseProductPageHtml`, `parseSellerFromHtml`) + types/constants (`ScrapedProduct`, `ProductEnrichment`, `EMPTY_ENRICHMENT`, `SITE_DOMAINS`, `SITE_GEO`, `categoryUrl`). No DI dependencies.
- `ml-scraper.service.ts` — `MlScraperService`. HTTP-only against Decodo; rate limiter + circuit breaker integration.
- `scraper-health.service.ts` — `ScraperHealthService` (circuit breaker) and `CircuitBreakerOpenError`.
- `scraper-semaphore.provider.ts` — process-wide concurrency cap (`SCRAPER_SEMAPHORE`).
- `scraper.module.ts` — registers all of the above; exports `MlScraperService` and `ScraperHealthService`.

### Decodo request shape

HTTP-only — no headless browser runs in our container. For each URL (category and product alike) the service POSTs to `https://scraper-api.decodo.com/v2/scrape` with:

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
      "timeout_s": 8 }
  ]
}
```

**Why this exact configuration:**

- `proxy_pool: standard` returns `status_code: 613` ("not able to scrape") for ML — Decodo's standard pool cannot pass the PoW challenge. Premium is the only viable pool.
- `headless: html` without JS rendering returns the PoW challenge page (~5–11 KB). ML's anti-bot validates TLS fingerprint, HTTP/2 frame ordering, and the runtime `window.snoopy.track('/anubis')` JS signal — only Decodo's premium + headless solver passes.
- `browser_actions` chain works around a Decodo-side bug: ML pages use streaming SSR (React Server Components). Decodo's renderer sometimes captures HTML before all chunks arrive, returning only the `<head>` (~5–11 KB) with a 200 status. The chain forces (a) a hard 4 s pause for streaming to complete, (b) `scroll_to_bottom` to trigger lazy-hydration sections, (c) `wait_for_element` to verify the price block is in the DOM. With this chain, validation runs hit 100 % success across two verticals (tools + electronics); without it, 5–10 % of requests came back head-only.

**Rate limiter:** sliding-window, capped at `DECODO_RATE_LIMIT_PER_SEC` (default 10, the Free/$19 plan ceiling). At real concurrency (8) and ~14 s per request, the effective rate is ~0.6 req/s — the limiter rarely binds. It is defensive against future concurrency increases or burst patterns. HTTP 429 from Decodo gets a 1 s backoff + single retry; per the docs, 429 responses are not billed.

**Billing-aware error handling:** by Decodo's response-code rules, `200`/`204` always bill, `4xx` with non-empty body bills, but `500`/`524`/`613` ("failed to scrape") do not. The failure path (HTML <50 KB → `EMPTY_ENRICHMENT`) treats partial-render successes as soft failures without retrying (a retry would always re-incur cost).

### Shared parsers (`ml-parsers.ts`)
- `parseCategoryHtml(html)` — cheerio extracts `li.ui-search-layout__item` elements → `ScrapedProduct[]`.
- `parseProductPageHtml(html)` — regex extracts `sold_count` (parsing "+X mil/millón vendidos"), `rating`, `review_count`, `brand`, `date_created`, `catalogProductId`, `categoryId` from inline `<script>` JSON.
- `parseSellerFromHtml(html)` — multi-pattern fallback for `seller_id`, `nickname`, `official_store_id`, `power_seller_status`, `total_products`, `total_sales`.
- `categoryUrl(siteId, categoryMlId)` — builds the `/mas-vendidos/{id}` URL using `SITE_DOMAINS`.
- `SITE_GEO` — 2-letter geo codes for Decodo's `geo` param (`MLC → cl`, etc.).

**3. Per-product enrichment via ML API.**
For each product with a `catalog_id`, `MercadoLibreClient.getCatalogProduct()` calls `GET /products/{catalog_id}` with a `client_credentials` OAuth2 token. Returns `date_created`. Runs in parallel with the page scraping via `pLimit(8)`.

**4. Leaf category resolution.**
`ProductCollectionService.resolveLeafCategory()` reads the `categoryId` extracted from each product page (the deepest category in the breadcrumb). If not already in the `categories` table, it calls `GET /categories/{leaf_id}` via ML API and inserts the leaf with `parent_id = root.id`. Cached per-`collect()`-run in `leafCategoryCache` to avoid duplicate API calls.

**5. Orchestration.**
`SyncRunnerService.run()` checks if categories exist in DB; if not, runs the category sync first. Then always runs product collection. Each step is wrapped in try/catch — a failure in one step does not prevent the other from running, and the response always includes structured error info. `WeeklySyncJob` in `src/scheduler/` calls this method on a configurable weekly cron, also wrapped in try/catch so a sync failure never crashes the scheduler.

## Data models

Defined in `prisma/schema.prisma`. All column names are in English.

- `Category` (`categories` table): two-level tree. Root categories have `parent_id = null`; leaf categories created during product scraping have `parent_id` pointing to their root. `ml_id` is the MercadoLibre ID (e.g. `"MLC1574"`), unique and indexed.
- `Product` (`products` table): immutable snapshots. `category_id` points to the leaf category when known (with `parent_id` pointing to the root); when no leaf is resolved, `category_id` is the root and `parent_id` is `null`. `snapshot_date` enables price history. Enrichment fields (`catalog_id`, `listing_id`, `date_created`, `sold_count`, `rating`, `review_count`, `brand`) are nullable — products without a catalog page (`/up/` URLs) will have `catalog_id = null` and possibly missing enrichment.
- `SyncProgress` (`sync_progress` table): per-category state for resumable syncs.
- `Seller` (`sellers` table): deduped seller profiles extracted from product pages.

## MercadoLibreClient

Manages the OAuth2 token (`client_credentials`) automatically: renews it if less than 60 s from expiry, using `performance.now()` (monotonic). If `ML_CLIENT_ID`/`ML_CLIENT_SECRET` are not configured, calls are made without auth (only public endpoints work).

## Known limitations

### Products without catalog page
Products that appear in más-vendidos via `/up/` URLs (no catalog product) cannot be enriched via API or product page scraping. They are saved with `catalog_id = null` and all enrichment fields as `null`. Name and price are still captured.

### Categories without "más vendidos" page
Some MercadoLibre parent categories do not have a `/mas-vendidos/{id}` page. These return 0 products and are listed in the `errores` array of the response. This is expected — not a bug.

### ML Search API is blocked
`/sites/{siteId}/search?category=...` returns 403 even with a valid OAuth2 `client_credentials` token. MercadoLibre no longer allows browsing third-party product listings via API. Scraping is the only viable approach.

### sold_quantity not available via API
The "+X mil vendidos" badge shown on product pages is not exposed through any ML API endpoint accessible with `client_credentials`. It is only available by scraping the product page HTML.

### Sync duration
Each category requires 1 category page + 20 product page requests to Decodo plus ~20 ML API calls for `date_created` + 0..N ML API calls for leaf categories not yet in DB. With `p-limit(3)` on categories, a full 32-parent-category sync takes ~13 minutes per site. The cron trigger is still recommended over manual HTTP — runs unattended and never blocks the API.

### Decodo head-only / streaming-SSR race
Decodo's headless renderer occasionally returns the HTML before ML's streaming SSR (React Server Components) finishes hydrating the `<body>`. Symptom: response is 5–11 KB with a fully-populated `<head>` (real `<title>`, OG tags, csrf-token, traceparent) but no body. `targetStatus` is 200 so it looks successful, only the size betrays it. Affects both category and product URLs randomly (the same URL fails ~5–10 % of the time without mitigation, succeeds on retry).

**Mitigation** (built into `MlScraperService`): every request chains `wait: 4s` → `scroll_to_bottom: 3s` → `wait_for_element: { selector, timeout_s: 8 }`. Validated at 100 % success across two verticals (`MLC1512` tools, `MLC1648` electronics, 42 pages each in standalone test). Without the chain, plain `wait_for_element` alone was insufficient — it failed identically when ML never rendered the selector, with the same head-only body.

Cost: every successful Decodo request takes ~14 s instead of ~10 s (the hard `wait` is non-conditional). Cost in $ is unchanged (Decodo bills per request, not per second). Runs overnight via cron so it is invisible to users.

## Scaling to multiple sites & platforms

### Current: Multi-site support (MercadoLibre only)

The application already supports multiple MercadoLibre sites without code changes:

```env
# .env — configure which sites to snapshot weekly (comma-separated)
SNAPSHOT_SITE_IDS=MLA,MLB,MLC,MLM,MCO,MPE,MLU,MLV   # Core 8 LatAm markets (default)
# Available: MLA (Argentina), MLB (Brazil), MLC (Chile), MLM (Mexico),
# MCO (Colombia), MPE (Peru), MLU (Uruguay), MLV (Venezuela),
# plus 11 smaller markets (MBO, MCR, MCU, MEC, MGT, MHN, MNI, MPA, MPY, MRD, MSV)
```

Behavior:
- **Categories** are always synced for **all** MercadoLibre sites via the official API (cheap, no scraping). `SNAPSHOT_SITE_IDS` does **not** filter categories.
- **Products** (the costly scraping step) only run for sites listed in `SNAPSHOT_SITE_IDS`.
- The weekly cron iterates over each listed site sequentially; a failure on one site does not stop the others.
- Each site's data lives in the same PostgreSQL database — isolated by `category.country` and unique `ml_id` per site.

### Planned: Multi-platform support

To add new platforms (Amazon, Shopee, Tokopedia, etc.):

**Phase 1: Adapter pattern** (non-invasive)
- Create `src/adapters/shopee/`, `src/adapters/tokopedia/`, etc.
- Each adapter exports a `Scraper` interface with `async getCategories(siteId)`, `async getProductsForCategory(categoryId)`, etc.
- Keep the MercadoLibre adapter intact.
- No changes to core services (`ProductCollectionService`, `SyncRunnerService`).

**Phase 2: Platform abstraction** (optional, if 3+ platforms)
- Add `platform` column to `categories` and `products` tables.
- Extend `POST /sync/run/:platform/:siteId`.
- Router selects adapter based on platform name.

**Current approach is MercadoLibre-only**: the scraper uses ML-specific selectors (`.poly-component__title`, `.ui-search-layout__item`), ML API endpoints, and ML site domains.

## Cost projections

ML has **19 sites** with **484 parent categories total**. Three realistic scopes:

| Scope | Sites | Parent cats | Req/sync | Req/mo (weekly) | Sync duration |
|---|---|---:|---:|---:|---|
| **Single site** (e.g. MLC) | 1 | 32 | 672 | ~2.9k | ~13 min |
| **Core 8 LatAm** (recommended) | MLA, MLB, MLC, MLM, MCO, MPE, MLU, MLV | 251 | 5.27k | ~22.8k | ~100 min |
| **All 19 sites** | every ML site | 484 | 10.16k | ~44k | ~2.5 h |

### Decodo cost per month

Decodo prepaid wallet — the more you load, the cheaper each request. Premium+JS rate per tier:

| Wallet loaded | Rate per 1K | 1 site (2.9k) | Core 8 (22.8k) | All 19 (44k) |
|---|---|---:|---:|---:|
| $19   | $1.50 | $4.37 | $34.23  | $66.02 |
| $49   | $1.25 | $3.64 | $28.52  | $55.01 |
| $99   | $1.20 | $3.49 | $27.38  | $52.81 |
| $249  | $1.15 | $3.35 | $26.24  | $50.61 |
| $499  | $1.10 | $3.20 | $25.09  | $48.41 |
| $999  | $1.05 | $3.06 | $23.95  | $46.21 |
| $1499 | $1.00 | $2.91 | $22.81  | $44.01 |

### Practical tier recommendation

- **1 site or Core 8 → stay on the $19 wallet.** Even at Core 8 ($34/mo), the $19 wallet refills monthly with minimal admin overhead. Upgrading to $249 saves only ~$8/mo and ties up 7 months of credit.
- **All 19 sites → consider $249** ($24/mo savings vs $19 tier, wallet lasts ~5 months). Above $249 the marginal savings flatten (~$2/mo per tier step).

Per-request math: parent_cats × 21 nav (1 cat + 20 prod) × 4.33 weeks/mo. Validated 100 % success rate, no retries factored in.

## Snapshot frequency recommendation

**Recommended: Weekly (current default)**
- Captures product ranking shifts, reviews accumulation, pricing trends
- Typical MercadoLibre dynamics: ~7–10 day cycles for top-seller rotation
- Per year: ~52 snapshots/category = good granularity for year-over-year analysis
- Cost at Core 8 scope: ~$34/mo Decodo ($19 tier)

**For additional granularity** (e.g., mid-week snapshots):
- Add a second cron job via environment config (e.g., Thursday 15 UTC)
- Cost: doubles the figures above — Core 8 still under $70/mo

**Not recommended:**
- **Daily**: 7× the weekly cost — too expensive for minimal incremental insight
- **Monthly**: Misses dynamic marketplace shifts; only good for historical snapshots
- **Quarterly**: Too coarse for market analysis

## Concurrency cap and circuit breaker

Two safety mechanisms gate every scraper request.

### Global concurrency semaphore

A single `p-limit(SCRAPER_MAX_CONCURRENT)` instance (default 10) lives in `ScraperModule` and is injected into `MlScraperService`. Every outbound request (category page or product page) acquires a slot before issuing the HTTP call and releases it on completion. The outer p-limits in `ProductCollectionService` (3 categories × 8 products = up to 24 in flight) are still there for batching, but the semaphore enforces the hard ceiling — so the Decodo Free/$19 plan's 10 req/s cap is never exceeded.

Configure via `SCRAPER_MAX_CONCURRENT` (env). Set to 1 to fully serialize, or higher if you upgrade the Decodo plan.

### Circuit breaker (`ScraperHealthService`)

Tracks **consecutive hard failures**. A hard failure is:
- Network error (DNS, TCP, timeout)
- Decodo HTTP 5xx (gateway error)
- Decodo `target_status` 5xx or 613 ("failed to scrape" — not billed)

NOT a hard failure (do not increment the counter): HTML <50 KB partial renders (returned as `EMPTY_ENRICHMENT`), product pages with no `catalog_id`, categories with no `/mas-vendidos` page.

When the counter reaches `SCRAPER_FAILURE_THRESHOLD` (default 10):
1. `tripped = true` is set; every subsequent `assertOpen()` throws `CircuitBreakerOpenError`.
2. Diagnostics are dumped to `${SCRAPER_FAILURE_DUMP_DIR}/{ISO-timestamp}/`:
   - `error.log` — JSON array of the last 20 `FailureSample` entries (URL, status, error message; no HTML bodies)
   - `sample.html` — raw response body of the most recent failure
   - `context.json` — trip metadata (timestamp, counter, threshold, last URL)
3. `CircuitBreakerOpenError` propagates up through the scraper into `ProductCollectionService`, which:
   - Marks the in-flight category as `failed` in `sync_progress`
   - Stops launching new categories
   - Returns `CollectionResult.aborted` populated with `pending_categories`, `completed_categories`, and `diagnostics_dir`

A single success resets the counter to 0. The breaker is reset at the start of each `collect()` call.

### Resume after abort

`POST /sync/resume/:siteId` finds the most recent unfinished `sync_run_id` for the site, resets `in_progress`/`failed` rows back to `pending`, and re-runs only the categories that are not yet `done`. The `sync_progress` table is the source of truth for what was completed — see [DATABASE.md](DATABASE.md) for the schema and lifecycle.

---

## Relevant settings

Defined in `src/config/app.config.ts`, read from `.env`:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | postgres local | Must use `postgresql://` |
| `ML_CLIENT_ID` | `""` | MercadoLibre OAuth2 client ID |
| `ML_CLIENT_SECRET` | `""` | MercadoLibre OAuth2 client secret |
| `ML_BASE_URL` | `https://api.mercadolibre.com` | ML API base URL |
| `DECODO_API_TOKEN` | `""` | Decodo Web Scraping API token (base64). Required. |
| `DECODO_RATE_LIMIT_PER_SEC` | `10` | Plan req/s cap: Free/$19=10, $49=25, $99=50, $249=100, $499=150, $999+=200. Sliding-window limiter caps `acquire()` calls. |
| `SCRAPER_MAX_CONCURRENT` | `10` | Hard cap on parallel scraper requests. Prevents the outer p-limits (3×8=24) from blowing past Decodo's plan rate. |
| `SCRAPER_FAILURE_THRESHOLD` | `10` | Consecutive hard failures before the circuit breaker trips, aborts the sync, and dumps diagnostics. |
| `SCRAPER_FAILURE_DUMP_DIR` | `tmp/scraper-failures` | Directory (relative to cwd) where the breaker writes `error.log`, `sample.html`, `context.json` on trip. |
| `SNAPSHOT_SITE_IDS` | `MLA` | Comma-separated MercadoLibre sites to snapshot weekly (`MLC,MLA,...`). Does not affect category sync (always runs for all sites). |
| `SNAPSHOT_CATEGORY_LIMIT` | unset | **Dev only.** Scrape only the first N parent categories per site (by `id` ASC). Unset/0 → all categories. |
| `SNAPSHOT_CATEGORIES_<SITE>` | unset | **Dev only.** Comma-separated whitelist of parent `ml_id`s for that site (e.g. `SNAPSHOT_CATEGORIES_MLC=MLC1574,MLC1648`). Takes precedence over `SNAPSHOT_CATEGORY_LIMIT`. |
| `SYNC_DAY_OF_WEEK` | `mon` | Day for weekly cron (mon–sun) |
| `SYNC_HOUR` | `3` | UTC hour for weekly cron |

## Adding a new model

1. Add the model to `prisma/schema.prisma`.
2. Run `npx prisma migrate dev --name description` to create and apply the migration.
3. Run `npx prisma generate` to regenerate the Prisma client (writes to `src/generated/prisma`).

## Code conventions

- **Everything in English**: all identifiers (variables, functions, classes, parameters, constants) and DB column names must be in English, no exceptions.

## Monitoring & debugging

### Logs during sync

All sync operations log to stdout/stderr:

```
[NestApplication] Nest application successfully started
[WeeklySyncJob] Weekly sync triggered for MLC
[SyncRunnerService] Starting sync for MLC
[CategorySyncService] Syncing categories for MLC
[MercadoLibreClient] OAuth token refreshed
[CategorySyncService] ✓ 250 root categories synced
[ProductCollectionService] Starting product collection (250 categories)
[MlScraperService] [MLC] MLC1512 → 20 products
[ProductCollectionService] Created leaf category MLC1234 → "..." (parent_id=N)
[ProductCollectionService] Saved 20 products for category MLC1512
[SyncRunnerService] Sync completed in 7200000ms (2h 0m)
```

Key log levels:
- **LOG**: Normal progress (categories synced, products found)
- **WARN**: Recoverable issues (category has 0 products, product page too small)
- **ERROR**: Failures that don't block the sync (product scrape timeout, API call failed, logged and skipped)

### Checking sync status in PostgreSQL

```sql
-- Last 10 product inserts per category
SELECT category_id, COUNT(*) as count, MAX(snapshot_date) as latest
FROM products
GROUP BY category_id
ORDER BY latest DESC
LIMIT 10;

-- Products missing enrichment (null sold_count, etc.)
SELECT COUNT(*) as missing_enrichment
FROM products
WHERE snapshot_date = CURRENT_DATE
  AND sold_count IS NULL;
```

### Triggering manual sync for testing

```bash
# Via HTTP (requires API running on localhost:8000)
curl -X POST http://localhost:8000/sync/run/MLC

# Via Prisma Studio to inspect results
npx prisma studio
  # Opens http://localhost:5555
```

### Scheduler configuration in code

See `src/scheduler/weekly-sync.job.ts`. The cron fires once per week at `SYNC_DAY_OF_WEEK` + `SYNC_HOUR` (UTC). To change schedule at runtime, edit `.env` and restart the API (`docker-compose restart api` or `npm run start:dev`). Scheduler config is loaded once at startup, no hot-reload.

## Validation script

`scripts/test-decodo.js` is a standalone Node script (uses built-in `fetch` + already-installed `cheerio` + `dotenv`) that validates the scraper end-to-end against MercadoLibre without touching the DB. It scrapes one category + its 20 products with the same `browser_actions` chain used by `MlScraperService`, classifies each result (`OK` / `BAD` based on size + DOM markers), dumps the raw HTML of any failed page into `tmp/decodo-bad/`, and prints a cost projection at the configured rate.

Run:
```bash
node scripts/test-decodo.js
# Configurable via env:
DECODO_TEST_SITE=MLC              # MLA, MLB, MLM, MLC, MCO, MLU, MLP, MLV, MLD, MLE
DECODO_TEST_CATEGORY=MLC1512      # parent ml_id (must have a /mas-vendidos page)
DECODO_TEST_PRODUCT_LIMIT=20      # cap on products scraped from the category
DECODO_TEST_CONCURRENCY=5         # parallel product requests
DECODO_TEST_RATE_LIMIT=10         # plan req/s cap
DECODO_TEST_PROXY_POOL=premium    # standard or premium (only premium works for ML)
```

Use as a smoke test after changing Decodo parameters or after Decodo / ML release changes that might affect rendering. ~$0.03 per run (21 requests × $1.50/1K at the Free tier rate).

## Tool usage

- **Context7 for new technologies**: whenever integrating a new library, framework or service not already in the project, use the context7 MCP to consult up-to-date documentation before writing code.
- **`scripts/test-decodo.js`** for smoke-testing the scraper without running the full app or touching the DB.
