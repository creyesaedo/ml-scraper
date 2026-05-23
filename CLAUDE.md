# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- `builder` stage: installs all dependencies (including devDependencies) and compiles TypeScript via `nest build`.
- `production` stage: installs only production dependencies (`--omit=dev`), adds OpenSSL (required by Prisma), and copies `dist/` from the builder.

Playwright is required as a production dependency — `MlScraperService` connects to Bright Data's Scraping Browser via CDP to render MercadoLibre pages that require JavaScript execution.

## Program flow

### Execution triggers

1. **Weekly cron job** (automatic, default: Monday 3 UTC)
   - Configured via `SYNC_DAY_OF_WEEK` and `SYNC_HOUR` in `.env`
   - `WeeklySyncJob` iterates over `SNAPSHOT_SITE_IDS` (comma-separated) and calls `SyncRunnerService.run(siteId)` for each
   - Runs on a fixed schedule, never blocks the API

2. **Manual HTTP endpoint** (on-demand)
   - `POST /sync/run/:siteId` — full cycle (categories + products)
   - For testing/debugging only — production should use the cron job (takes ~2-3 hours for 484 categories)

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
         │               │     Returns: all parent categories for the site (e.g. MLC = Chile)
         │               ├─ UPSERT root categories → categories table
         │               │     (parent_id = null, ml_id = MercadoLibre category ID)
         │               └─ p-limit(8): parallel per root category
         │                   └─ GET /categories/{parent_id} (ML API, OAuth2)
         │                       Returns: children of this parent category
         │                       UPSERT → categories table (parent_id = root.id)
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
                             │   ── ONE Scraping Browser CDP session for entire category ──
                             │   ├─ chromium.connectOverCDP(BRIGHTDATA_SCRAPING_BROWSER_WS)
                             │   ├─ browser context = shared for all 21 navigations
                             │   │
                             │   ├─ Step 1: Scrape category page
                             │   │   ├─ page.goto('https://www.{domain}/mas-vendidos/{categoryMlId}')
                             │   │   │     Bright Data auto-solves PoW challenge
                             │   │   ├─ waitForSelector('li.ui-search-layout__item', 15s timeout)
                             │   │   └─ cheerio parses HTML → 20 products
                             │   │       Extracts: name, price, catalog_id, listing_id, product_url
                             │   │
                             │   └─ Step 2: Scrape 20 product pages in parallel (p-limit(8))
                             │       ├─ Per product:
                             │       │   ├─ context.newPage() (shared JS bundle cache)
                             │       │   ├─ page.route('**/*', ...) → strict blocking
                             │       │   │     Only document requests allowed
                             │       │   │     Everything else (JS, CSS, images) aborted
                             │       │   ├─ page.goto(product_url)
                             │       │   ├─ Extract enrichment via regex on raw HTML
                             │       │   │     sold_count: "+X mil vendidos" badge
                             │       │   │     rating, review_count: JSON script tags
                             │       │   │     brand, catalogProductId, categoryId (leaf)
                             │       │   └─ Return ProductEnrichment or EMPTY_ENRICHMENT
                             │       │
                             │       └─ Returns: Map<productUrl, ProductEnrichment>
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
                             │   │   │     Returns: category metadata
                             │   │   └─ UPSERT → categories table
                             │   │       (parent_id = root.id, ml_id = categoryId)
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

#### Health check
```http
GET /health
→ 200 OK
{
  "status": "ok"
}
```

#### Category queries (read-only)
```http
GET /categorias
→ 200 OK — all categories in DB
[
  {
    "id": 1,
    "ml_id": "MLC1574",
    "parent_id": null,
    "name": "Electrónica",
    ...
  },
  ...
]

GET /categorias?solo_padres=true
→ 200 OK — only root categories (parent_id IS NULL)
[
  {
    "id": 1,
    "ml_id": "MLC1574",
    "parent_id": null,
    ...
  },
  ...
]
```

#### Product snapshots (read-only)
```http
GET /productos?category_id=123
→ 200 OK — all product snapshots for this category
[
  {
    "id": 1,
    "name": "iPhone 15",
    "price": "499999",
    "snapshot_date": "2026-05-23",
    "sold_count": 2500,
    "rating": 4.8,
    "review_count": 342,
    "brand": "Apple",
    "category_id": 456,
    "parent_id": 1,
    "date_created": "2024-01-15T10:30:00Z",
    ...
  },
  ...
]
```

#### Manual sync (on-demand, for testing only)
```http
POST /sync/run/:siteId
Body: {} (empty)
→ 202 Accepted / 200 OK (sync starts immediately, runs in background)
{
  "message": "Sync started for MLC",
  "siteId": "MLC",
  "timestamp": "2026-05-23T10:00:00Z",
  "categories": {
    "synced": 250,
    "errors": 2,
    "errores": [
      { "category": "MLC9999", "error": "No /mas-vendidos page" }
    ]
  },
  "products": {
    "inserted": 4850,
    "errors": 12
  },
  "duration_ms": 7200000
}

POST /sync/categorias/:siteId
Body: {}
→ Sync categories only (skip product collection)
{
  "message": "Category sync completed for MLC",
  "siteId": "MLC",
  "categories": { "synced": 250, "errors": 2 },
  ...
}

POST /sync/productos/:siteId
Body: {}
→ Sync products only (categories must already exist in DB)
{
  "message": "Product collection completed for MLC",
  "siteId": "MLC",
  "products": { "inserted": 4850, "errors": 12 },
  ...
}
```

## Architecture

**1. Category sync — via MercadoLibre official API**
`CategorySyncService` uses `MercadoLibreClient` (axios) to fetch the category tree for a site (e.g. `MLC`). It upserts root categories first (via `prisma.category.upsert`) to get their DB IDs, then fetches their children in parallel with `Promise.allSettled` + `pLimit(8)`. Individual subcategory failures are logged and skipped — they do not abort the full sync.

**2. Product collection — single batched Scraping Browser session per category**

`MlScraperService.scrapeCategoryWithProducts(siteId, categoryMlId, productConcurrency=8)` opens **one** CDP connection per category and reuses the same `BrowserContext` for all 21 navigations (1 category page + 20 product pages). This keeps the browser's JS cache warm, so external bundles are downloaded once instead of 20 times.

**Bandwidth optimization — two-level resource blocking**

Bright Data Scraping Browser bills per GB of proxy traffic. The service blocks unnecessary resources at two levels:

- **Context level (`applyResourceBlocking`)** — applied to all pages in the context. Blocks images (`png/jpg/webp/svg/...`), fonts (`woff/woff2/ttf/...`), media (`mp4/mp3/...`), and tracking domains (`google-analytics`, `googletagmanager`, `facebook.net`, `snoopy.mercadolibre.com`, `criteo`, `doubleclick`). The category page still runs JS in case Bright Data needs it for PoW challenge resolution.

- **Page level (`applyStrictBlockingForProductPage`)** — applied only to product pages. Aborts every request whose `resourceType()` is not `document`, so the browser only downloads the main HTML. Product page data (`sold_count`, `rating`, `review_count`, `brand`, `catalogProductId`, `categoryId`) is server-rendered into inline `<script>` tags in the initial HTML, so no JS execution is needed — `parseProductPageHtml` extracts via regex on the raw HTML string.

Measured bandwidth (MLC1512 = 1 category + 20 products): **~6.7 MB**, compared to ~77 MB with one CDP session per product (pre-optimization). At $8/GB, a full 484-category sync costs ~$26.

**Why Scraping Browser everywhere instead of Web Unlocker for product pages**

We tested `context.request.get(url)` to bypass browser rendering for product pages — it returned the PoW challenge page (~5.8 KB) even with bypass cookies (`_bm_skipml=true`, `_bmc`, `_bmstate`) already set in the context. MercadoLibre's anti-bot validates more than cookies: TLS fingerprint, HTTP/2 frame ordering, and runtime `window.snoopy.track('/anubis')` JS signals. Only real browser navigations (`page.goto`) pass — and Bright Data's challenge solver only works for those. Therefore product pages also go through `page.goto()` with strict route blocking.

**3. Per-product enrichment via ML API**
For each product with a `catalog_id`, `MercadoLibreClient.getCatalogProduct()` calls `GET /products/{catalog_id}` with a `client_credentials` OAuth2 token. Returns `date_created`. Runs in parallel with the page scraping via `pLimit(8)`.

**4. Leaf category resolution**
`ProductCollectionService.resolveLeafCategory()` reads the `categoryId` extracted from each product page (the deepest category in the breadcrumb). If not already in the `categories` table, it calls `GET /categories/{leaf_id}` via ML API and inserts the leaf with `parent_id = root.id`. Cached per-`collect()`-run in `leafCategoryCache` to avoid duplicate API calls.

**5. Orchestration**
`SyncRunnerService.run()` checks if categories exist in DB; if not, runs the category sync first. Then always runs product collection. Each step is wrapped in try/catch — a failure in one step does not prevent the other from running, and the response always includes structured error info. `WeeklySyncJob` in `src/scheduler/` calls this method on a configurable weekly cron, also wrapped in try/catch so a sync failure never crashes the scheduler.

## Data models

Defined in `prisma/schema.prisma`. All column names are in English.

- `Category` (`categories` table): two-level tree. Root categories have `parent_id = null`; leaf categories created during product scraping have `parent_id` pointing to their root. `ml_id` is the MercadoLibre ID (e.g. `"MLC1574"`), unique and indexed.
- `Product` (`products` table): immutable snapshots. `category_id` points to the leaf category when known (with `parent_id` pointing to the root); when no leaf is resolved, `category_id` is the root and `parent_id` is `null`. `snapshot_date` enables price history. Enrichment fields (`catalog_id`, `listing_id`, `date_created`, `sold_count`, `rating`, `review_count`, `brand`) are nullable — products without a catalog page (`/up/` URLs) will have `catalog_id = null` and possibly missing enrichment.

## MercadoLibreClient

Manages the OAuth2 token (`client_credentials`) automatically: renews it if less than 60s from expiry, using `performance.now()` (monotonic). If `ML_CLIENT_ID`/`ML_CLIENT_SECRET` are not configured, calls are made without auth (only public endpoints work).

## MlScraperService

The service exposes a single public method plus an exported constant:

**`scrapeCategoryWithProducts(siteId, categoryMlId, productConcurrency = 8)`** — returns `{ products: ScrapedProduct[], enrichmentsByUrl: Map<string, ProductEnrichment> }`. Opens one Scraping Browser CDP session, scrapes the `/mas-vendidos/{categoryMlId}` page, then scrapes the 20 product pages found, all reusing the same `BrowserContext`. The map is keyed by `product_url` so callers can look up enrichment without a second scrape.

**`EMPTY_ENRICHMENT`** — exported constant. Returned when a product URL is missing, the page is < 50 KB (challenge), or a navigation errors. Callers use it as the safe default.

Private helpers:
- `scrapeProductPageInContext(context, productUrl)` — applies `applyStrictBlockingForProductPage`, navigates, returns `ProductEnrichment` extracted via `parseProductPageHtml`.
- `applyResourceBlocking(context)` — context-wide route blocking for images, fonts, media, and tracking domains.
- `applyStrictBlockingForProductPage(page)` — page-scoped route that aborts every non-document request. Page-level routes take precedence over context-level routes.
- `parseCategoryHtml(html)` — cheerio extracts `li.ui-search-layout__item` elements.
- `parseProductPageHtml(html)` — regex extracts `sold_count` (parsing "+X mil/millón vendidos"), `rating`, `review_count`, `brand`, `date_created`, `catalogProductId`, `categoryId` from inline `<script>` JSON.

Error handling:
- Missing `BRIGHTDATA_SCRAPING_BROWSER_WS` → logs ERROR and returns empty result
- `page.goto` timeout (60s) → caught, returns `EMPTY_ENRICHMENT` for that product, other products continue
- HTML < 50 KB (challenge page) → logs WARN, returns `EMPTY_ENRICHMENT`
- Fatal browser/CDP error → logs ERROR, returns `{ products: [], enrichmentsByUrl: new Map() }` for the whole category, other categories continue

The category page does **not** get strict blocking (only the context-level permissive block) — Bright Data may need JS to resolve the PoW challenge there. Product pages do not trigger the challenge in practice.

## Known limitations

### Products without catalog page
Products that appear in más-vendidos via `/up/` URLs (no catalog product) cannot be enriched via API or product page scraping. They are saved with `catalog_id = null` and all enrichment fields as `null`. Name and price are still captured.

### Categories without "más vendidos" page
Some MercadoLibre parent categories do not have a `/mas-vendidos/{id}` page. These return 0 products and are listed in the `errores` array of the response. This is expected — not a bug.

### ML Search API is blocked
`/sites/{siteId}/search?category=...` returns 403 even with a valid OAuth2 `client_credentials` token. MercadoLibre no longer allows browsing third-party product listings via API. Scraping via Bright Data is the only viable approach.

### sold_quantity not available via API
The "+X mil vendidos" badge shown on product pages is not exposed through any ML API endpoint accessible with `client_credentials`. It is only available by scraping the product page HTML.

### Sync duration
Each category requires one Scraping Browser session that does 21 navigations (1 category + 20 products) plus ~20 ML API calls for `date_created` + 0..N ML API calls for leaf categories not yet in DB. Single-category benchmark: ~35-50 seconds. With `p-limit(3)` on categories, a full 484-category sync takes ~2-3 hours. For production use, trigger via cron only — not via HTTP.

### `context.request.get()` cannot bypass the browser
We tested using `context.request.get(productUrl)` (Playwright `APIRequestContext`) to skip browser rendering on product pages. Even with bypass cookies already in the context, ML's CloudFront/anti-bot serves the PoW challenge page (~5.8 KB) instead of the real product page. The browser fingerprint (TLS, HTTP/2, runtime JS snoopy signal) is part of the validation. Bright Data's challenge solver only kicks in on `page.goto()` navigations.

## Scaling to multiple sites & platforms

### Current: Multi-site support (MercadoLibre only)

The application already supports multiple MercadoLibre sites without code changes:

```env
# .env — configure which sites to snapshot weekly (comma-separated)
SNAPSHOT_SITE_IDS=MLC,MLA       # Will snapshot Chile and Argentina each week
# Available sites: MLA (Argentina), MLB (Brazil), MLC (Chile), MLM (Mexico),
# MLU (Uruguay), MLP (Peru), MLV (Venezuela), etc.
```

Behavior:
- **Categories** are always synced for **all** MercadoLibre sites via the official API (cheap, no scraping). `SNAPSHOT_SITE_IDS` does **not** filter categories.
- **Products** (the costly Bright Data scraping step) only run for sites listed in `SNAPSHOT_SITE_IDS`.
- The weekly cron iterates over each listed site sequentially; a failure on one site does not stop the others.
- Each site's data lives in the same PostgreSQL database — isolated by `category.country` and unique `ml_id` per site.

### Planned: Multi-platform support

To add new platforms (Amazon, Shopee, Tokopedia, etc.):

**Phase 1: Adapter pattern** (non-invasive)
- Create `src/adapters/shopee/`, `src/adapters/tokopedia/`, etc.
- Each adapter exports `Scraper` interface: `async getCategories(siteId)`, `async getProductsForCategory(categoryId)`, etc.
- Keep `MercadoLibreAdapter` in `src/adapters/mercadolibre/`
- No changes to core services (`ProductCollectionService`, `SyncRunnerService`)

**Phase 2: Platform abstraction** (optional, if 3+ platforms)
- Add `platform` column to `categories` and `products` tables
- Extend `POST /sync/run/:platform/:siteId`
- Router selects adapter based on platform name

**Current approach is MercadoLibre-only**: The scraper uses ML-specific selectors (`.poly-component__title`, `.ui-search-layout__item`), ML API endpoints, and ML site domains. To add another platform, write a new `Scraper` service for that platform and wire it into `ProductCollectionService`.

## Snapshot frequency recommendation

**Recommended: Weekly (current default)**
- Captures product ranking shifts, reviews accumulation, pricing trends
- Typical MercadoLibre dynamics: ~7–10 day cycles for top-seller rotation
- Cost: ~$26/sync at $8/GB (484 categories × 6.76 MB = 3.27 GB)
- Per year: ~52 snapshots/category = good granularity for year-over-year analysis

**For additional granularity** (e.g., mid-week snapshots):
- Add a second cron job via environment config (e.g., Thursday 15 UTC)
- Cost: ~$52/week total (~$2,700/year)
- Useful if analyzing week-over-week volatility or fast-moving categories

**Not recommended:**
- **Daily**: $182/week — too expensive for minimal incremental insight
- **Monthly**: Misses dynamic marketplace shifts; only good for historical snapshots
- **Quarterly**: Too coarse for market analysis

## Relevant settings

Defined in `src/config/app.config.ts`, read from `.env`:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | postgres local | Must use `postgresql://` (no asyncpg) |
| `ML_CLIENT_ID` | `""` | MercadoLibre OAuth2 client ID |
| `ML_CLIENT_SECRET` | `""` | MercadoLibre OAuth2 client secret |
| `ML_BASE_URL` | `https://api.mercadolibre.com` | ML API base URL |
| `BRIGHTDATA_SCRAPING_BROWSER_WS` | `""` | Bright Data Scraping Browser WSS endpoint (CDP) |
| `SNAPSHOT_SITE_IDS` | `MLA` | Comma-separated MercadoLibre sites to snapshot weekly (`MLC,MLA,...`). Does not affect category sync (always runs for all sites). |
| `SNAPSHOT_CATEGORY_LIMIT` | unset | **Dev only.** Scrape only the first N parent categories per site (by `id` ASC). Unset/0 → all categories. |
| `SNAPSHOT_CATEGORIES_<SITE>` | unset | **Dev only.** Comma-separated whitelist of parent `ml_id`s for that site (e.g. `SNAPSHOT_CATEGORIES_MLC=MLC1574,MLC1648`). Takes precedence over `SNAPSHOT_CATEGORY_LIMIT`. |
| `SYNC_DAY_OF_WEEK` | `mon` | Day for weekly cron (mon–sun) |
| `SYNC_HOUR` | `3` | UTC hour for weekly cron |

## Adding a new model

1. Add the model to `prisma/schema.prisma`.
2. Run `npx prisma migrate dev --name description` to create and apply the migration.
3. Run `npx prisma generate` to update the Prisma client types.

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
[ProductCollectionService] [MLC1512] → 20 products
[MlScraperService] [MLC1512] sold_count=2450, rating=4.8, reviews=342
[ProductCollectionService] [MLC1512] Leaf category MLC1234 → UPSERT
[ProductCollectionService] ✓ Inserted 4850 product snapshots
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

-- Average products per category
SELECT category_id, COUNT(*) as total_snapshots, COUNT(DISTINCT snapshot_date) as snapshot_count
FROM products
GROUP BY category_id
ORDER BY snapshot_count DESC;
```

### Triggering manual sync for testing

```bash
# Via HTTP (requires API running on localhost:8000)
curl -X POST http://localhost:8000/sync/run/MLC

# Via Prisma Studio to inspect results
npx prisma studio
  # Opens http://localhost:5555
  # Browse tables: categories, products
```

### Scheduler configuration in code

See `src/scheduler/weekly-sync.job.ts`:

```typescript
@Cron(CronExpression.EVERY_WEEK)
// Recurrence: once per week, day specified by SYNC_DAY_OF_WEEK
// Time: SYNC_HOUR (UTC)
async handleCron() {
  // Wraps SyncRunnerService.run() in try/catch
  // A sync failure never crashes the scheduler
}
```

To change schedule at runtime (without .env restart):
- Modify `SYNC_DAY_OF_WEEK` and `SYNC_HOUR` in `.env`
- Restart the application: `docker-compose restart api` or `npm run start:dev`
- Scheduler loads config on startup, no hot-reload

## Tool usage

- **Context7 for new technologies**: whenever integrating a new library, framework or service not already in the project, use the context7 MCP to consult up-to-date documentation before writing code.
