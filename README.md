# ML-Scraper

Weekly snapshots of MercadoLibre's top-selling products per category, persisted to PostgreSQL for trend analysis. The service bypasses MercadoLibre's JavaScript proof-of-work challenge through Decodo's premium headless API, enriches each product with both scraped HTML fields and OAuth2 API metadata, and stores immutable per-day rows so price and ranking history can be queried over time.

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
| Scraper backend | Decodo Web Scraping API (`/v2/scrape`, premium pool, `headless: html`) |
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

| `APP_MODE` | Sites scraped | Categories per site | Decodo cost / run |
|---|---|---|---|
| `DEVELOPMENT` (default) | One site picked at random from the Core 8 | One random parent category from the DB | ~$0.03 (21 requests) |
| `PRODUCTION` | Core 8: `MLA, MLB, MLC, MLM, MCO, MPE, MLU, MLV` | All parent categories per site | ~$8 (≈5,270 requests) |

Any other value (blank, mis-typed) falls back to `DEVELOPMENT` for safety.

## Prerequisites

- Node.js 20 or higher
- PostgreSQL 16 (or run via the included `docker-compose.yml`)
- A [Decodo](https://decodo.com/) account with a Web Scraping API token — needed to render MercadoLibre pages that enforce a JS proof-of-work challenge. The Free / $19 tier covers a single site at weekly cadence; Core 8 still fits comfortably (~$34/mo).
- (Optional) A MercadoLibre developer app with `client_credentials` OAuth2 access — needed to call `/products/{id}` and `/categories/{id}`. Without it, only scraped fields are populated.

## Setup

```bash
git clone <repo-url>
cd b2b-market-analysis
npm install

cp .env.example .env
# Edit .env: at minimum set DATABASE_URL, DECODO_API_TOKEN, APP_MODE

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
| `DECODO_API_TOKEN` | `""` | yes | Decodo Web Scraping API token (base64). |
| `DECODO_RATE_LIMIT_PER_SEC` | `10` | no | Plan req/s ceiling (Free/$19 = 10, $49 = 25, $99 = 50, …). |
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
                ├─ Sliding-window rate limit (DECODO_RATE_LIMIT_PER_SEC)
                ├─ POST scraper-api.decodo.com/v2/scrape   (premium pool, headless html)
                │     browser_actions: wait 4s → scroll_to_bottom 3s → wait_for_element 8s
                ├─ Step 1: category page → cheerio → 20 products
                ├─ Step 2: p-limit(8) product pages
                │     <50 KB body → soft failure (EMPTY_ENRICHMENT, no retry, billed)
                │     5xx / 613    → hard failure → circuit breaker++
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
POST /sync/categories          # Categories only — all ML sites
POST /sync/products/:siteId    # Products only (categories must already exist)
POST /sync/resume/:siteId      # Resume the most recent aborted sync_run
```

A full `PRODUCTION` sync takes ~13 min per site (≈100 min for Core 8). Prefer the GitHub Actions cron over manual HTTP — runs unattended and never blocks the API.

### Read

```http
GET /health                          # → { status: 'ok' }
GET /categories?parent_only=true     # All root categories
GET /products?category_id=<id>       # Paginated product snapshots, filterable by category
```

## Project layout

```
src/
├── adapters/
│   ├── mercadolibre/      # OAuth2 + REST client (axios)
│   └── scraper/           # Decodo Web Scraping API + parsers + circuit breaker
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
└── ml-sync.yml            # Weekly cron + workflow_dispatch
scripts/
└── test-decodo.js         # Standalone smoke test (no DB, ~$0.03/run)
```

## Data model

All column names in English.

- **`categories`** — two-level tree. Root categories have `parent_id = null`. Leaf categories (created on demand during product scraping) have `parent_id` pointing to a root. `ml_id` is the MercadoLibre category ID (unique, indexed).
- **`products`** — immutable snapshots. `snapshot_date` enables price/ranking history. When the leaf is known, `category_id` = leaf and `parent_id` = root; otherwise `category_id` = root and `parent_id` = null. Enrichment fields (`catalog_id`, `ml_public_id`, `listing_id`, `date_created`, `sold_count`, `rating`, `review_count`, `brand`) are nullable.
- **`sync_progress`** — per-category lifecycle (`pending` → `in_progress` → `done` / `failed`) for resumable runs.
- **`sellers`** — deduped seller profiles extracted from product pages.

See [DATABASE.md](./DATABASE.md) for the full schema.

## How the scraper bypasses MercadoLibre's anti-bot

MercadoLibre serves a JavaScript proof-of-work challenge to most non-browser HTTP requests. Decodo's `/v2/scrape` with `proxy_pool: premium` + `headless: html` is the only configuration that consistently passes; the standard pool returns `status_code: 613` ("failed to scrape").

To work around Decodo's headless cutting off mid-render on ML's streaming SSR pages, every request chains `wait: 4s` → `scroll_to_bottom: 3s` → `wait_for_element` (price selector for product pages, list-item selector for category pages). Without this chain, ~5–10 % of responses come back as head-only HTML (5–11 KB instead of the real 400 KB+). With the chain, validation runs hit 100 % success across two verticals.

A sliding-window rate limiter caps starts at `DECODO_RATE_LIMIT_PER_SEC`; HTTP 429 responses get a single 1 s backoff retry (not billed). A separate global semaphore (`SCRAPER_MAX_CONCURRENT`) caps total in-flight requests so the outer `p-limit(3 categories × 8 products)` cannot blow past the plan rate. A circuit breaker counts consecutive hard failures (network errors, Decodo 5xx, `target_status` 5xx/613) and aborts the run after `SCRAPER_FAILURE_THRESHOLD`, dumping diagnostics and leaving `sync_progress` in a state that `POST /sync/resume/:siteId` can pick up.

## Scope

ML has **19 sites** with **484 parent categories total**. Three realistic operating scopes:

| Scope | Sites | Parent cats | Req/sync | Req/mo (weekly) | Sync duration |
|---|---|---:|---:|---:|---|
| **Single site** (e.g. MLC) | 1 | 32 | 672 | ~2.9k | ~13 min |
| **Core 8 LatAm** (`APP_MODE=PRODUCTION`) | MLA MLB MLC MLM MCO MPE MLU MLV | 251 | 5.27k | ~22.8k | ~100 min |
| **All 19 sites** | every ML site | 484 | 10.16k | ~44k | ~2.5 h |

### Decodo cost per month

| Wallet loaded | Rate per 1K | 1 site (2.9k) | Core 8 (22.8k) | All 19 (44k) |
|---|---|---:|---:|---:|
| $19   | $1.50 | $4.37 | $34.23 | $66.02 |
| $49   | $1.25 | $3.64 | $28.52 | $55.01 |
| $99   | $1.20 | $3.49 | $27.38 | $52.81 |
| $249  | $1.15 | $3.35 | $26.24 | $50.61 |
| $499  | $1.10 | $3.20 | $25.09 | $48.41 |

Small markets (Bolivia, Cuba, Costa Rica, Ecuador, Guatemala, Honduras, Nicaragua, Panama, Paraguay, Dominican Rep, El Salvador) are excluded from the Core 8 default — low e-commerce volume, rarely worth the cost for market analysis.

## Known limitations

- **Single-platform.** Scraper logic is MercadoLibre-specific (selectors, API endpoints, site domains). Adding Amazon / Shopee / Tokopedia requires a new adapter under `src/adapters/`.
- **Products from `/up/` URLs** (non-catalog listings) have `catalog_id = null` and may have partial enrichment — there is no catalog page to read.
- **Categories without a `/mas-vendidos/{id}` page** return 0 products and are reported in the `errores` array. Not all parent categories have a top-sellers page; this is expected.
- **`sold_count` is not available through the MercadoLibre API.** The "+X mil vendidos" badge is rendered only in the product page HTML, so it must be scraped.
- **ML Search API is blocked** for `client_credentials` tokens (`/sites/{siteId}/search?category=...` → 403). Scraping is the only viable approach for listings.
- **Streaming-SSR head-only race.** Decodo's renderer occasionally returns the HTML before ML's React Server Components finish hydrating. Mitigated by the `wait_for_element` chain, but the mitigation costs ~4 s of fixed wait per request (cost in $ unchanged, since Decodo bills per request, not per second).
- **Sync duration.** Each category requires 1 category page + 20 product pages via Decodo plus ~20 ML API calls. With `p-limit(3)` on categories, a 32-parent-category site takes ~13 min — manual HTTP triggers will block the response that long.
- **GitHub Actions schedule decay.** GitHub disables scheduled workflows after 60 days of repo inactivity. Any commit reactivates them.
- **No native Prisma engine.** Project uses the driver-adapter path (`@prisma/adapter-pg`). If you switch back to the native engine, you'll need to add OpenSSL to the production image and re-enable engine downloads.

## Validation script

`scripts/test-decodo.js` is a standalone Node script (built-in `fetch` + `cheerio` + `dotenv`) that validates the scraper end-to-end without touching the DB. Scrapes one category + its 20 products with the same `browser_actions` chain used in production, classifies each result (`OK` / `BAD`), dumps failed HTML into `tmp/decodo-bad/`, and prints a cost projection.

```bash
node scripts/test-decodo.js
# Configurable: DECODO_TEST_SITE, DECODO_TEST_CATEGORY, DECODO_TEST_PRODUCT_LIMIT,
# DECODO_TEST_CONCURRENCY, DECODO_TEST_RATE_LIMIT, DECODO_TEST_PROXY_POOL
```

Use as a smoke test after changing Decodo parameters or when Decodo / ML release changes that might affect rendering. ~$0.03 per run.

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
node scripts/test-decodo.js   # Scraper smoke test
```

See [CLAUDE.md](./CLAUDE.md) for the deep architecture reference, circuit-breaker internals, and full env-var matrix.

## License

Private project — not licensed for external use without permission.
