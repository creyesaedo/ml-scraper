# ml-scraper (worker)

Stateless **scraping worker** for MercadoLibre. It performs all fetching —
Decodo web scraping + the MercadoLibre official API + FX rates + holidays — and
returns persist-ready data over HTTP. **It owns no database.** Persistence and
orchestration live in the sibling [`ml-service`](../ml-service) project, which
is the only caller of this worker.

```
ml-service (DB owner) ──HTTP──> ml-scraper (this, worker) ──> Decodo / ML API / FX / holidays
```

## Run

```bash
npm install
npm run build && npm start        # listens on PORT (default 8001)
# or: npm run start:dev
npm test
```

Copy `.env.example` to `.env` and set `DECODO_API_TOKEN`, `ML_CLIENT_ID`,
`ML_CLIENT_SECRET`, and `DECODO_RATE_LIMIT_PER_SEC`. No `DATABASE_URL`.

## Endpoints (internal — called by ml-service)

| Method / Route | Returns |
|---|---|
| `POST /scrape/category/:siteId/:categoryId` | `{ products: EnrichedProduct[] }` — one category's best-sellers, fully enriched |
| `POST /scrape/product` (body `{ url, siteId? }`) | `EnrichedProduct` — one product page (siteId inferred from the URL) |
| `GET /scrape/probe/:siteId/:categoryId` | `{ verdict }` — best-sellers probe (category page only) |
| `GET /ml/sites` | every ML site (official API) |
| `GET /ml/categories/:siteId` | a site's root categories (official API) |
| `GET /health` | `{ status: 'ok' }` |

A run-level abort (circuit breaker or Decodo account error) returns HTTP 503
with `{ error: 'scraper_abort', reason, ... }` so ml-service can stop and resume.

The contract type produced here is `src/worker/enriched-product.dto.ts`; a copy
lives in `ml-service/src/adapters/scraper-client/` — keep the two in sync.

See `CLAUDE.md` for the full worker architecture. The database schema lives in
[`ml-service`](../ml-service) (this worker owns no DB).
