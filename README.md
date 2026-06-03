# ML-Scraper

Weekly snapshots of MercadoLibre's top-selling products per category, stored in PostgreSQL as immutable per-day rows so price and ranking history can be queried over time. It bypasses MercadoLibre's JS proof-of-work challenge via Decodo's premium headless API and enriches each product with both scraped HTML fields and OAuth2 API metadata.

**Stack:** NestJS 10 · TypeScript 5 · Prisma 7 (`@prisma/adapter-pg`) · PostgreSQL 16 / Neon · Decodo Web Scraping API · Jest.

## Program flow

For each parent category of a site (e.g. `MLC` = Chile), one sync run:

1. **Categories** — if the site has none in the DB, syncs the category tree from the official ML API (`/sites/{id}/categories`).
2. **Scrape** — fetches the `/mas-vendidos/{category_id}` page through Decodo (premium pool, `headless: html`) → up to 20 top products.
3. **Enrich** — adds `date_created`, `catalog_id`, `ml_public_id`, `sold_count`, `rating`, `review_count`, `brand` and the leaf category, combining product-page HTML with the ML API.
4. **Store** — inserts one immutable snapshot row per product with `snapshot_date = today` into the `products` table.

```
TRIGGER → SyncRunnerService.run(siteId)
            ├─ CategorySyncService.sync()   (only if DB has 0 categories)
            └─ ProductCollectionService.collect()
                 └─ p-limit(3) categories → MlScraperService (Decodo)
                      → enrich (ML API + HTML) → INSERT snapshots
```

A circuit breaker aborts the run after too many consecutive scraper failures, dumps diagnostics, and leaves progress resumable via `POST /sync/resume/:siteId`.

## Scope

- **Single platform:** MercadoLibre only (ML-specific selectors, API endpoints, domains).
- **`APP_MODE`** is the single switch for what gets scraped:
  - `DEVELOPMENT` (default) — one random site + one random parent category (~$0.03/run).
  - `PRODUCTION` — Core 7 LatAm (`MLA MLB MLC MLM MCO MPE MLU`), all parent categories (~$7/run, ≈90 min).
- ML has 19 sites / 484 parent categories total; the Core 7 cover ~225 of them. Costs ≈ $30/mo at the Decodo $19 tier. Venezuela (MLV) and Dominican Republic (MLD) are excluded — reduced/classifieds-only markets with no best-sellers section.

## Usage

**Prerequisites:** Node.js 20+, PostgreSQL 16 (or the bundled Docker), a Decodo API token, and (optional) a MercadoLibre OAuth2 app for API enrichment.

```bash
npm install
cp .env.example .env          # set DATABASE_URL, DECODO_API_TOKEN, APP_MODE
npx prisma generate
npx prisma db push
```

Run it one of three ways (all share `SyncRunnerService.run`):

```bash
# 1. CLI — iterates sites from APP_MODE, or pass a single site
npm run sync:run
npm run sync:run MLC

# 2. HTTP API (dev server on :8000)
npm run start:dev
curl -X POST http://localhost:8000/sync/run/MLC

# 3. Docker (api + postgres + pgadmin)
docker-compose up
```

**GitHub Actions** runs the production sync automatically (`.github/workflows/ml-sync.yml`, Monday 03:00 UTC).

### HTTP API

```http
POST /sync/run/:siteId         # Full cycle: categories (if empty) + products
POST /sync/resume/:siteId      # Resume the most recent aborted run
GET  /categories?parent_only=true
GET  /products?category_id=<id>        # Paginated; also ?country, ?search, ?page, ?limit
GET  /products/history?ml_public_id=X  # Price/ranking history for one product
```

### Smoke test

`node scripts/test-decodo.js` validates the scraper end-to-end without touching the DB (~$0.03/run).

## More detail

- **[CLAUDE.md](./CLAUDE.md)** — full architecture, circuit-breaker internals, complete env-var matrix, cost projections.
- **[DATABASE.md](./DATABASE.md)** — schema (`categories`, `products`, `sync_progress`, `sellers`) and example queries.

## License

Private project — not licensed for external use without permission.
