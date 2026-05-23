# ML-Scraper

Weekly snapshots of MercadoLibre's top-selling products per category, persisted to PostgreSQL for trend analysis. Built with NestJS + Prisma + Playwright, using Bright Data's Scraping Browser to bypass MercadoLibre's JavaScript proof-of-work challenge.

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
| ORM | Prisma 5 + PostgreSQL 16 |
| HTTP client | axios |
| HTML parsing | cheerio + regex |
| Browser automation | Playwright (CDP) |
| Scraping proxy | Bright Data Scraping Browser |
| Scheduler | `@nestjs/schedule` (cron) |
| Concurrency | `p-limit` |

## Prerequisites

- Node.js 20 or higher
- PostgreSQL 16 (or run via the included `docker-compose.yml`)
- A [Bright Data](https://brightdata.com/) account with a **Scraping Browser** zone — needed to render MercadoLibre pages that enforce a JS proof-of-work challenge. Free tier suffices for testing.
- (Optional) A MercadoLibre developer app with `client_credentials` OAuth2 access — needed to call `/products/{id}` and `/categories/{id}`. Without it, only the scraped fields are populated.

## Setup

```bash
# Clone and install
git clone <repo-url>
cd b2b-market-analysis
npm install

# Copy and fill the env file
cp .env.example .env
# Edit .env: at minimum set DATABASE_URL and BRIGHTDATA_SCRAPING_BROWSER_WS

# Generate Prisma client + apply schema
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
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/market_analysis` | yes | PostgreSQL connection string (`postgresql://` only) |
| `BRIGHTDATA_SCRAPING_BROWSER_WS` | `""` | yes | Bright Data Scraping Browser WSS endpoint (CDP) |
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
POST /sync/categorias          # Categories only — body: { siteId }
POST /sync/productos/:siteId   # Products only (categories must already exist)
```

A full sync of 484 parent categories takes ~2–3 hours. Trigger via cron in production, not via HTTP request.

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
│   └── scraper/           # Playwright + Bright Data Scraping Browser
├── categories/            # Read endpoints + category sync
├── products/              # Read endpoints
├── sync/                  # Orchestration (SyncRunnerService, ProductCollectionService)
├── scheduler/             # Weekly cron job
├── prisma/                # Prisma service (DI wrapper)
└── config/                # env-based config registered with @nestjs/config
prisma/
└── schema.prisma          # Two tables: categories, products
```

## Data model

Two tables, all column names in English.

- **`categories`** — two-level tree. Root categories have `parent_id = null`. Leaf categories (created on demand during product scraping) have `parent_id` pointing to a root. `ml_id` is the MercadoLibre category ID (unique, indexed).
- **`products`** — immutable snapshots. `snapshot_date` enables price/ranking history. When the leaf category is known, `category_id` = leaf and `parent_id` = root; otherwise `category_id` = root and `parent_id` = null. Enrichment fields are nullable for products without a catalog page.

## How the scraper minimizes Bright Data bandwidth

Bright Data Scraping Browser bills per GB of proxy traffic. The scraper applies two optimizations:

1. **One CDP session per category, not per page.** `scrapeCategoryWithProducts` opens one browser context and reuses it for all 21 navigations (1 category page + 20 product pages). The browser's JS bundle cache stays warm — bundles are downloaded once, not 20 times.

2. **Two-level resource blocking via `page.route()`:**
   - Context level: blocks images, fonts, media, and tracking domains (`google-analytics`, `googletagmanager`, `snoopy.mercadolibre.com`, etc.).
   - Page level: for **product pages**, aborts every request whose `resourceType()` is not `document`. Product data is server-rendered into inline `<script>` tags, so regex extraction on the raw HTML works without any JS execution.

Measured cost: ~6.7 MB per category × 484 categories = ~3.2 GB per sync → ~$26 at $8/GB (vs. ~$300 with naive one-session-per-product).

See [CLAUDE.md](./CLAUDE.md) for the full architecture, error handling details, and known limitations.

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
- **`context.request.get()` cannot bypass the challenge.** Even with all bypass cookies set, MercadoLibre's anti-bot serves the challenge page to raw HTTP requests. Only real browser navigations (`page.goto`) work, because Bright Data's challenge solver only runs in that path.

## License

Private project — not licensed for external use without permission.
