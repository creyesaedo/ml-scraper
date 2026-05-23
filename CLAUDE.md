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

```
TRIGGER: POST /sync/run/:siteId  OR  weekly cron (WeeklySyncJob)
         │
         ▼
   SyncRunnerService.run()
         │
         ├─ DB has 0 categories?
         │   └─ YES → CategorySyncService.sync()
         │               ├─ GET /sites/{siteId}/categories  (ML API, OAuth2)
         │               ├─ UPSERT root categories → DB
         │               └─ p-limit(8): GET /categories/{id} per root
         │                   └─ UPSERT subcategories → DB
         │
         └─ ProductCollectionService.collect()
                 ├─ SELECT parent categories FROM DB
                 └─ p-limit(3): per category
                         │
                         ├─ MlScraperService.scrapeCategoryWithProducts()
                         │   ── ONE Scraping Browser CDP session for the whole category ──
                         │       ├─ chromium.connectOverCDP(BRIGHTDATA_SCRAPING_BROWSER_WS)
                         │       ├─ context.route(...) → block images, fonts, media,
                         │       │   analytics/tracking domains (saves ~50% bandwidth)
                         │       ├─ Page #1: GET /mas-vendidos/{ml_id}
                         │       │     → Bright Data resuelve PoW challenge automáticamente
                         │       │     → cheerio extrae 20 productos: name, price,
                         │       │       catalog_id, listing_id, product_url
                         │       └─ p-limit(8): scrapeProductPageInContext()
                         │             ├─ context.newPage() (shared JS cache)
                         │             ├─ page.route('**/*') aborts everything except
                         │             │   the document → ~6.7 MB total per category
                         │             ├─ page.goto(product_url)
                         │             └─ regex sobre HTML inline extrae:
                         │                  sold_count, rating, review_count, brand,
                         │                  catalogProductId, categoryId (leaf)
                         │
                         ├─ p-limit(8): MercadoLibreClient.getCatalogProduct() per product
                         │     └─ GET /products/{catalog_id} (ML API, OAuth2) → date_created
                         │
                         ├─ resolveLeafCategory(): UPSERT leaf category (parent_id=root)
                         │   via ML API GET /categories/{leaf_id} + DB cache per run
                         │
                         └─ INSERT snapshots → products table
                              (category_id = leaf, parent_id = root when leaf found;
                               category_id = root, parent_id = null otherwise)

HTTP query endpoints (read-only, no side effects):
  GET /health                      → { status: 'ok' }
  GET /categorias?solo_padres=true → categories from DB
  GET /productos?category_id=123   → product snapshots from DB

Manual sync endpoints:
  POST /sync/run/:siteId           → full cycle (categories + products)
  POST /sync/categorias/:siteId    → categories only
  POST /sync/productos/:siteId     → products only
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

## Relevant settings

Defined in `src/config/app.config.ts`, read from `.env`:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | postgres local | Must use `postgresql://` (no asyncpg) |
| `ML_CLIENT_ID` | `""` | MercadoLibre OAuth2 client ID |
| `ML_CLIENT_SECRET` | `""` | MercadoLibre OAuth2 client secret |
| `ML_BASE_URL` | `https://api.mercadolibre.com` | ML API base URL |
| `BRIGHTDATA_SCRAPING_BROWSER_WS` | `""` | Bright Data Scraping Browser WSS endpoint (CDP) |
| `SYNC_SITE_ID` | `MLA` | MercadoLibre site to sync |
| `SYNC_DAY_OF_WEEK` | `mon` | Day for weekly cron (mon–sun) |
| `SYNC_HOUR` | `3` | UTC hour for weekly cron |

## Adding a new model

1. Add the model to `prisma/schema.prisma`.
2. Run `npx prisma migrate dev --name description` to create and apply the migration.
3. Run `npx prisma generate` to update the Prisma client types.

## Code conventions

- **Everything in English**: all identifiers (variables, functions, classes, parameters, constants) and DB column names must be in English, no exceptions.

## Tool usage

- **Context7 for new technologies**: whenever integrating a new library, framework or service not already in the project, use the context7 MCP to consult up-to-date documentation before writing code.
