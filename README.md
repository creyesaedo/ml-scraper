# ML-Scraper

Weekly snapshots of MercadoLibre's top-selling products per category, persisted to PostgreSQL for trend analysis. Built with NestJS + Prisma 7 + Decodo's Web Scraping API to bypass MercadoLibre's JavaScript proof-of-work challenge.

## What it does

For each parent category of a MercadoLibre site (e.g. `MLC` = Chile), the service:

1. Scrapes the `/mas-vendidos/{category_id}` page to get the top 20 products
2. Enriches each product with `date_created` (MercadoLibre OAuth2 API), `sold_count`, `rating`, `review_count`, `brand`, and `leaf_category_id` (scraped from the product page HTML)
3. Resolves and persists the leaf category (deepest level of the breadcrumb) if not already known
4. Inserts an immutable snapshot row with `snapshot_date` into the `products` table

A weekly cron triggers the full sync; HTTP endpoints expose the persisted data for downstream consumption.

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 20+ |
| Framework | NestJS 10 |
| ORM | Prisma 7 (driver adapter: `@prisma/adapter-pg`) + PostgreSQL 16 |
| HTTP client | axios + native `fetch` |
| HTML parsing | cheerio + regex |
| Scraper | Decodo Web Scraping API (`/v2/scrape`, premium pool, headless HTML) |
| Scheduler | `@nestjs/schedule` (cron) |
| Concurrency | `p-limit` + sliding-window rate limiter + global semaphore |

## Prerequisites

- Node.js 20 or higher
- PostgreSQL 16 (or run via the included `docker-compose.yml`)
- A [Decodo](https://decodo.com/) account with a Web Scraping API token — needed to render MercadoLibre pages that enforce a JS proof-of-work challenge. The Free/$19 tier suffices for one site (~$4–$8/mo per site at weekly cadence).
- (Optional) A MercadoLibre developer app with `client_credentials` OAuth2 access — needed to call `/products/{id}` and `/categories/{id}`. Without it, only the scraped fields are populated.

## Setup

```bash
git clone <repo-url>
cd b2b-market-analysis
npm install

cp .env.example .env
# Edit .env: at minimum set DATABASE_URL and DECODO_API_TOKEN

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

## Configuration

| Variable | Default | Required | Description |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/market_analysis` | yes | PostgreSQL connection string |
| `DECODO_API_TOKEN` | `""` | yes | Decodo Web Scraping API token (base64) |
| `DECODO_RATE_LIMIT_PER_SEC` | `10` | no | Plan req/s cap (Free/$19=10, $49=25, …) |
| `SCRAPER_MAX_CONCURRENT` | `10` | no | Hard cap on parallel scraper requests |
| `SCRAPER_FAILURE_THRESHOLD` | `10` | no | Consecutive hard failures before the circuit breaker trips |
| `ML_CLIENT_ID` | `""` | no | MercadoLibre OAuth2 client ID |
| `ML_CLIENT_SECRET` | `""` | no | MercadoLibre OAuth2 client secret |
| `ML_BASE_URL` | `https://api.mercadolibre.com` | no | ML API base URL |
| `SNAPSHOT_SITE_IDS` | `MLA` | no | Comma-separated MercadoLibre sites to snapshot weekly (`MLC,MLA,MLB`). Categories are synced for all sites regardless. |
| `SYNC_DAY_OF_WEEK` | `mon` | no | Day of week for the weekly cron (`mon`–`sun`) |
| `SYNC_HOUR` | `3` | no | UTC hour for the weekly cron |

## HTTP API

### Sync (write)

```http
POST /sync/run/:siteId         # Full cycle: categories (if empty) + products
POST /sync/categorias          # Categories only — syncs all ML sites
POST /sync/productos/:siteId   # Products only (categories must already exist)
POST /sync/resume/:siteId      # Resume the most recent aborted sync_run
```

A full sync of 32 parent categories takes ~13 minutes per site. Trigger via cron in production, not via HTTP request.

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
│   ├── mercadolibre/      # OAuth2 + API client (axios)
│   └── scraper/           # Decodo Web Scraping API
├── categories/            # Read endpoints + category sync
├── products/              # Read endpoints
├── sync/                  # Orchestration (SyncRunnerService, ProductCollectionService)
├── scheduler/             # Weekly cron job
├── prisma/                # Prisma service (DI wrapper, driver adapter)
└── config/                # env-based config registered with @nestjs/config
prisma/
└── schema.prisma          # categories, products, sync_progress, sellers
prisma.config.ts           # Prisma 7 datasource URL config
```

## Data model

All column names in English.

- **`categories`** — two-level tree. Root categories have `parent_id = null`. Leaf categories (created on demand during product scraping) have `parent_id` pointing to a root. `ml_id` is the MercadoLibre category ID (unique, indexed).
- **`products`** — immutable snapshots. `snapshot_date` enables price/ranking history. When the leaf category is known, `category_id` = leaf and `parent_id` = root; otherwise `category_id` = root and `parent_id` = null. Enrichment fields are nullable for products without a catalog page.
- **`sync_progress`** — per-category state for resumable syncs. See [DATABASE.md](./DATABASE.md).
- **`sellers`** — deduped seller profiles extracted from product pages.

## How the scraper bypasses MercadoLibre's anti-bot

MercadoLibre serves a JavaScript proof-of-work challenge to most non-browser HTTP requests. Decodo's `/v2/scrape` endpoint with `proxy_pool: premium` + `headless: html` is the only configuration that consistently passes; both the standard proxy pool and plain HTTP requests return either the challenge page or `status_code: 613` ("failed to scrape").

To work around Decodo's headless cutting off mid-render on ML's streaming SSR pages, every request chains `wait: 4s` → `scroll_to_bottom: 3s` → `wait_for_element` (price selector for product pages, search-result selector for category pages). Without this chain, ~5–10 % of responses come back as head-only HTML (5–11 KB instead of the real 400 KB+).

A sliding-window rate limiter caps starts at `DECODO_RATE_LIMIT_PER_SEC`; HTTP 429 responses get a single 1 s backoff retry (not billed). A separate global semaphore (`SCRAPER_MAX_CONCURRENT`) caps total in-flight requests across the whole process so the outer `p-limit(3 categories × 8 products)` cannot blow past the plan rate.

**Three realistic scopes** (ML has 19 sites with 484 parent categories total):

| Scope | Sites | Decodo $19/mo | Decodo $249/mo |
|---|---|---:|---:|
| Single site (e.g. MLC) | 1 | ~$4.37 | ~$3.35 |
| **Core 8 LatAm** (default) | MLA MLB MLC MLM MCO MPE MLU MLV | **~$34** | ~$26 |
| All 19 sites | every ML site | ~$66 | ~$51 |

Small markets (Bolivia, Cuba, Costa Rica, Ecuador, Guatemala, Honduras, Nicaragua, Panama, Paraguay, Dominican Rep, El Salvador) are excluded from the default — low e-commerce volume, rarely worth the cost for market analysis.

See [CLAUDE.md](./CLAUDE.md) for the full architecture, circuit-breaker behavior, and known limitations.

## Useful commands

```bash
npm install               # Install dependencies (project uses npm install, not npm ci)
npm run start:dev         # Dev server with watch mode
npm run build             # Compile TypeScript to dist/
npm test                  # Jest unit tests
npx prisma db push        # Apply schema.prisma to the DB without creating a migration
npx prisma migrate dev    # Create + apply a versioned migration
npx prisma studio         # GUI to browse/edit the DB
```

## Known limitations

- **Products from `/up/` URLs** (non-catalog listings) have `catalog_id = null` and may have partial enrichment.
- **Categories without a `/mas-vendidos/{id}` page** return 0 products and are reported in the `errores` array. This is expected — not all parent categories have a top-sellers page.
- **`sold_count` is not available through the MercadoLibre API.** The "+X mil vendidos" badge is rendered only in the product page HTML, so it must be scraped.
- **ML Search API is blocked** for `client_credentials` tokens — scraping is the only viable approach.

## License

Private project — not licensed for external use without permission.
