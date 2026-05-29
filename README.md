# ML-Scraper

Weekly snapshots of MercadoLibre's top-selling products per category, persisted to PostgreSQL for trend analysis. The service bypasses MercadoLibre's JavaScript proof-of-work challenge through Bright Data's Web Unlocker, enriches each product with both scraped HTML fields and OAuth2 API metadata, and stores immutable per-day rows so price and ranking history can be queried over time.

## What it does

For each parent category of a MercadoLibre site (e.g. `MLC` = Chile), the service:

1. Scrapes the `/mas-vendidos/{category_id}` page to get the top 20 products
2. Enriches each product with `date_created`, `catalog_id`, `ml_public_id`, `sold_count`, `rating`, `review_count`, `brand`, and the leaf category from the product page HTML
3. Resolves and persists the leaf category (deepest level of the breadcrumb) if not already known
4. Inserts an immutable snapshot row with `snapshot_date` into the `products` table

A weekly GitHub Actions cron triggers the full sync; HTTP endpoints expose the persisted data for downstream consumption.

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Language | TypeScript 5 (CommonJS output) |
| Framework | NestJS 10 |
| ORM | Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg` driver adapter — no native engine) |
| Database | PostgreSQL 16 locally, Neon (serverless Postgres + pgBouncer) in production |
| HTTP client | axios + native `fetch` |
| HTML parsing | cheerio + targeted regex over inline `<script>` JSON |
| Scraper backend | Bright Data Web Unlocker (`api.brightdata.com/request`, `format: raw`, `x-unblock-expect`) |
| Concurrency | `p-limit` (per-stage) + sliding-window rate limiter + process-wide semaphore |
| Scheduler | GitHub Actions `schedule:` cron (default); optional in-process `@nestjs/schedule` |
| Container | Multi-stage Dockerfile + docker-compose (api / postgres / pgadmin) |
| Tests | Jest + ts-jest |

## Execution modes

The scraper can be triggered three different ways. All share the same code path (`SyncRunnerService.run`).

| Mode | Trigger | Used for |
|---|---|---|
| **GitHub Actions** (default) | `.github/workflows/ml-sync.yml` — `schedule: 0 3 * * 1` + `workflow_dispatch` | Production. Monday 03:00 UTC, runs against Neon. |
| **CLI** | `npm run sync:run [siteId]` | Local testing, ad-hoc runs, self-hosted cron. |
| **HTTP API** | `POST /sync/run/:siteId` against a running NestJS server | Self-hosted deploy via Docker, external orchestrators. |

The in-process NestJS scheduler (`WeeklySyncJob`) is off by default and only registers when `ENABLE_INTERNAL_SCHEDULER=true`. This avoids double-scheduling when GitHub Actions is the source of timing.

## APP_MODE

A single env var controls which sites and categories are scraped. It is the source of truth — `SNAPSHOT_SITE_IDS` and `SNAPSHOT_CATEGORIES_*` are ignored when `APP_MODE` is set, by design (prevents accidental production spend from a typo).

| `APP_MODE` | Sites scraped | Categories per site | Bright Data cost / run |
|---|---|---|---|
| `DEVELOPMENT` (default) | One site picked at random from the Core 8 | One random parent category from the DB | ~$0.03 (21 requests + ~10% retries) |
| `PRODUCTION` | Core 8: `MLA, MLB, MLC, MLM, MCO, MPE, MLU, MLV` | All parent categories per site | ~$8 (≈5,270 requests + ~10% retries) |

Any other value (blank, mis-typed) falls back to `DEVELOPMENT` for safety.

## Prerequisites

- Node.js 20 or higher
- PostgreSQL 16 (or run via the included `docker-compose.yml`)
- A [Bright Data](https://brightdata.com/) account with a Web Unlocker zone and API key — needed to render MercadoLibre pages that enforce a JS proof-of-work challenge. Pay-per-request; a single site at weekly cadence is ~$5/mo, Core 8 ~$38/mo (entry rate, incl. hybrid retries).
- (Optional) A MercadoLibre developer app with `client_credentials` OAuth2 access — needed to call `/products/{id}` and `/categories/{id}`. Without it, only scraped fields are populated.

## Setup

```bash
git clone <repo-url>
cd b2b-market-analysis
npm install

cp .env.example .env
# Edit .env: at minimum set DATABASE_URL, BRIGHTDATA_API_TOKEN, BRIGHTDATA_ZONE, APP_MODE

npx prisma generate
npx prisma db push
```

### Run with Docker Compose (recommended for local dev)

```bash
docker-compose up
```

Brings up three services:
- `api` — NestJS app on `http://localhost:8000` (runs `prisma db push` on start)
- `db` — PostgreSQL 16 on `localhost:5432`
- `pgadmin` — pgAdmin 4 on `http://localhost:5050` (login: `admin@admin.com` / `admin`)

### Run locally

```bash
# Requires PostgreSQL already running
npm run start:dev
```

### Run a one-off sync from the CLI

```bash
# Iterates over the sites derived from APP_MODE
npm run sync:run

# Or override to a single siteId
npm run sync:run MLC
```

## Configuration

| Variable | Default | Required | Description |
|---|---|---|---|
| `APP_MODE` | `DEVELOPMENT` | no | `DEVELOPMENT` (random site + random parent category) or `PRODUCTION` (Core 8, all parent categories). |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/market_analysis` | yes | Runtime connection. In production points to Neon's **pooled** URL (`...-pooler.neon.tech`). |
| `DIRECT_URL` | unset | conditional | Direct (non-pooled) URL used by `prisma db push` / `migrate`. Required when `DATABASE_URL` points to pgBouncer. |
| `BRIGHTDATA_API_TOKEN` | `""` | yes | Bright Data API key (Bearer token) for Web Unlocker. |
| `BRIGHTDATA_ZONE` | `market_analysis` | no | Web Unlocker zone name from the Bright Data control panel. |
| `SCRAPER_RATE_LIMIT_PER_SEC` | `10` | no | Defensive sliding-window cap on request starts per second. |
| `SCRAPER_MAX_CONCURRENT` | `10` | no | Hard cap on parallel scraper requests across the whole process. |
| `SCRAPER_FAILURE_THRESHOLD` | `10` | no | Consecutive hard failures before the circuit breaker trips. |
| `SCRAPER_FAILURE_DUMP_DIR` | `tmp/scraper-failures` | no | Where the breaker dumps `error.log`, `sample.html`, `context.json` on trip. |
| `ML_CLIENT_ID` | `""` | no | MercadoLibre OAuth2 client ID. |
| `ML_CLIENT_SECRET` | `""` | no | MercadoLibre OAuth2 client secret. |
| `ML_BASE_URL` | `https://api.mercadolibre.com` | no | ML API base URL. |
| `ENABLE_INTERNAL_SCHEDULER` | `false` | no | Opt-in for the in-process NestJS cron. Off by default to avoid double-scheduling with GitHub Actions. |
| `SYNC_DAY_OF_WEEK` | `mon` | no | In-process cron day (only used when `ENABLE_INTERNAL_SCHEDULER=true`). |
| `SYNC_HOUR` | `3` | no | In-process cron UTC hour (same condition). |

## System flow

```
TRIGGER  GitHub Actions cron  |  CLI (npm run sync:run)  |  HTTP POST /sync/run/:siteId
                                            │
                                            ▼
                          SyncRunnerService.run(siteId)
                                            │
                       ┌───────── DB has 0 categories for site? ──────────┐
                       │ YES                                              │ NO
                       ▼                                                  │
            CategorySyncService.sync(siteId)                              │
              ├─ GET /sites/{siteId}/categories  (ML OAuth2)              │
              ├─ UPSERT roots                                             │
              └─ p-limit(8) per root → GET /categories/{id} → UPSERT      │
                                            │                            │
                                            ▼ ◄──────────────────────────┘
                          ProductCollectionService.collect(siteId)
                                            │
                       SELECT parent categories WHERE parent_id IS NULL
                                            │
                                  p-limit(3) categories in parallel
                                            │
                                            ▼
              MlScraperService.scrapeCategoryWithProducts(siteId, categoryMlId)
                ├─ Acquire semaphore slot (SCRAPER_MAX_CONCURRENT)
                ├─ Sliding-window rate limit (SCRAPER_RATE_LIMIT_PER_SEC)
                ├─ POST api.brightdata.com/request   (format: raw, Bearer auth)
                │     attempt 1: x-unblock-expect: {"element": SELECTOR}
                │     <50 KB clean → retry once WITHOUT the header (full auto-render)
                ├─ Step 1: category page → cheerio → 20 products
                ├─ Step 2: p-limit(8) product pages
                │     <50 KB body → soft failure (EMPTY_ENRICHMENT, billed)
                │     net err / BD HTTP err / x-brd-err-code → hard failure → circuit breaker++
                └─ Returns { products, enrichmentsByUrl }
                                            │
              ┌─────────────────────────────┼─────────────────────────────┐
              ▼                             ▼                             ▼
   MercadoLibreClient                ResolveLeafCategory             INSERT product
   .getCatalogProduct()              GET /categories/{leaf}          snapshots → DB
   GET /products/{cat_id}            (cached per run)                snapshot_date = today
   → date_created                                                    enrichment merged
                                            │
                                            ▼
                       Circuit breaker tripped? → abort, dump diagnostics,
                                                  mark in-flight categories failed,
                                                  return { aborted: { … } }
                                            │
                                            ▼
                                    Sync run complete
```

## HTTP API

### Sync (write)

```http
POST /sync/run/:siteId         # Full cycle: categories (if empty) + products
POST /sync/categorias          # Categories only — all ML sites
POST /sync/productos/:siteId   # Products only (categories must already exist)
POST /sync/resume/:siteId      # Resume the most recent aborted sync_run
```

A full `PRODUCTION` sync takes ~13 min per site (≈100 min for Core 8). Prefer the GitHub Actions cron over manual HTTP — runs unattended and never blocks the API.

### Read

```http
GET /health                          # → { status: 'ok' }
GET /categorias?solo_padres=true     # All root categories
GET /productos?category_id=<id>      # Latest product snapshots for a category
```

## Project layout

```
src/
├── adapters/
│   ├── mercadolibre/      # OAuth2 + REST client (axios)
│   └── scraper/           # Bright Data Web Unlocker + parsers + circuit breaker
├── categories/            # Read endpoints + category sync
├── products/              # Read endpoints
├── sync/                  # Orchestration (SyncRunnerService, ProductCollectionService)
├── scheduler/             # Optional in-process weekly cron
├── cli/                   # run-sync.ts entry point (used by `npm run sync:run`)
├── prisma/                # PrismaService (DI wrapper, driver adapter)
└── config/                # @nestjs/config registration + APP_MODE resolution
prisma/
└── schema.prisma          # categories, products, sync_progress, sellers
prisma.config.ts           # Prisma 7 datasource URL (DATABASE_URL / DIRECT_URL)
.github/workflows/
├── ml-sync.yml            # Weekly cron + workflow_dispatch
└── brightdata-test.yml    # Manual single-category scraper validation
scripts/
└── test-brightdata.js     # Standalone smoke test (no DB, ~$0.03/run)
```

## Data model

All column names in English.

- **`categories`** — two-level tree. Root categories have `parent_id = null`. Leaf categories (created on demand during product scraping) have `parent_id` pointing to a root. `ml_id` is the MercadoLibre category ID (unique, indexed).
- **`products`** — immutable snapshots. `snapshot_date` enables price/ranking history. When the leaf is known, `category_id` = leaf and `parent_id` = root; otherwise `category_id` = root and `parent_id` = null. Enrichment fields (`catalog_id`, `ml_public_id`, `listing_id`, `date_created`, `sold_count`, `rating`, `review_count`, `brand`) are nullable.
- **`sync_progress`** — per-category lifecycle (`pending` → `in_progress` → `done` / `failed`) for resumable runs.
- **`sellers`** — deduped seller profiles extracted from product pages.

See [DATABASE.md](./DATABASE.md) for the full schema.

## How the scraper bypasses MercadoLibre's anti-bot

MercadoLibre serves a JavaScript proof-of-work challenge to most non-browser HTTP requests. Bright Data's Web Unlocker (`api.brightdata.com/request`, `format: raw`) passes it automatically with its internal Chromium rendering engine.

ML uses streaming SSR, so Web Unlocker can return a page mid-render. The scraper uses a **hybrid strategy**: attempt 1 sends the `x-unblock-expect` header (Web Unlocker waits until a CSS selector is present — fixes head-only responses on category and fast product pages); if that returns a clean response below 50 KB (the signature of the header's fixed ~25–30 s internal timeout on slow CBT pages, which render in 27–44 s), it retries once **without** the header so Web Unlocker waits for the full auto-render. Validated 100 % on `MLC1648`, ~10 % of pages need the retry.

A sliding-window rate limiter caps starts at `SCRAPER_RATE_LIMIT_PER_SEC`; network errors and HTTP 429 each get a single 1 s backoff retry. A global semaphore (`SCRAPER_MAX_CONCURRENT`) caps total in-flight requests. A circuit breaker counts consecutive hard failures (network errors, Bright Data HTTP errors, or an `x-brd-err-code` on the response such as `client_10050` = IP not in the zone allowlist) and aborts the run after `SCRAPER_FAILURE_THRESHOLD`, dumping diagnostics and leaving `sync_progress` in a state that `POST /sync/resume/:siteId` can pick up.

## Scope

ML has **19 sites** with **484 parent categories total**. Three realistic operating scopes:

| Scope | Sites | Parent cats | Req/sync | Req/mo (weekly) | Sync duration |
|---|---|---:|---:|---:|---|
| **Single site** (e.g. MLC) | 1 | 32 | 672 | ~2.9k | ~13 min |
| **Core 8 LatAm** (`APP_MODE=PRODUCTION`) | MLA MLB MLC MLM MCO MPE MLU MLV | 251 | 5.27k | ~22.8k | ~100 min |
| **All 19 sites** | every ML site | 484 | 10.16k | ~44k | ~2.5 h |

### Bright Data cost per month

Web Unlocker is pay-per-request; with the `x-unblock-expect` custom feature every request bills (success + failure), and the hybrid retry adds ~10 %. Figures use the entry rate of $1.50/1K (drops with monthly volume) including the retry overhead:

| Scope | Req/mo (+retries) | Cost/mo @ $1.50/1K |
|---|---:|---:|
| 1 site  | ~3.2k  | ~$4.80 |
| Core 8  | ~25.1k | ~$37.65 |
| All 19  | ~48.4k | ~$72.60 |

Small markets (Bolivia, Cuba, Costa Rica, Ecuador, Guatemala, Honduras, Nicaragua, Panama, Paraguay, Dominican Rep, El Salvador) are excluded from the Core 8 default — low e-commerce volume, rarely worth the cost for market analysis.

## Known limitations

- **Single-platform.** Scraper logic is MercadoLibre-specific (selectors, API endpoints, site domains). Adding Amazon / Shopee / Tokopedia requires a new adapter under `src/adapters/`.
- **Products from `/up/` URLs** (non-catalog listings) have `catalog_id = null` and may have partial enrichment — there is no catalog page to read.
- **Categories without a `/mas-vendidos/{id}` page** return 0 products and are reported in the `errores` array. Not all parent categories have a top-sellers page; this is expected.
- **`sold_count` is not available through the MercadoLibre API.** The "+X mil vendidos" badge is rendered only in the product page HTML, so it must be scraped.
- **ML Search API is blocked** for `client_credentials` tokens (`/sites/{siteId}/search?category=...` → 403). Scraping is the only viable approach for listings.
- **Streaming-SSR render races.** Web Unlocker can return head-only HTML (plain render) or a 0-byte 200 (`x-unblock-expect` timing out on slow pages). Mitigated by the hybrid expect→plain-retry strategy; the ~10 % of pages that retry are billed twice.
- **Sync duration.** Each category requires 1 category page + 20 product pages via Bright Data (+~10 % retries) plus ~20 ML API calls; Web Unlocker requests take ~15–40 s each. With `p-limit(3)` on categories, a 32-parent-category site takes ~13–18 min — manual HTTP triggers will block the response that long.
- **GitHub Actions schedule decay.** GitHub disables scheduled workflows after 60 days of repo inactivity. Any commit reactivates them.
- **No native Prisma engine.** Project uses the driver-adapter path (`@prisma/adapter-pg`). If you switch back to the native engine, you'll need to add OpenSSL to the production image and re-enable engine downloads.

## Validation script

`scripts/test-brightdata.js` is a standalone Node script (built-in `fetch` + `cheerio`, `dotenv` optional) that validates the scraper end-to-end without touching the DB. Scrapes one category + its 20 products with the same hybrid render strategy used in production, classifies each result (`OK` / `BAD`), dumps failed HTML into `tmp/brightdata-bad/`, and prints a billing-aware cost projection. It can also be run from GitHub Actions via the **Bright Data Test** workflow (`workflow_dispatch`).

```bash
node scripts/test-brightdata.js
# Configurable: BRIGHTDATA_API_TOKEN, BRIGHTDATA_ZONE, BRD_TEST_SITE, BRD_TEST_CATEGORY,
# BRD_TEST_PRODUCT_LIMIT, BRD_TEST_CONCURRENCY, BRD_TEST_EXPECT, BRD_TEST_RATE_PER_1K
```

Use as a smoke test after changing Web Unlocker parameters or when Bright Data / ML changes might affect rendering. ~$0.03 per run.

## Useful commands

```bash
npm install               # Install deps (project uses npm install, not npm ci)
npm run start:dev         # Dev server with watch mode
npm run build             # Compile TypeScript to dist/
npm run sync:run [site]   # One-shot sync from the CLI
npm test                  # Jest unit tests
npx prisma db push        # Apply schema.prisma without creating a migration
npx prisma migrate dev    # Create + apply a versioned migration
npx prisma studio         # GUI to browse / edit the DB
node scripts/test-brightdata.js   # Scraper smoke test
```

See [CLAUDE.md](./CLAUDE.md) for the deep architecture reference, circuit-breaker internals, and full env-var matrix.

## License

Private project — not licensed for external use without permission.
