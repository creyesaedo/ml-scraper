# Graph Report - ml-scraper  (2026-06-26)

## Corpus Check
- 38 files · ~24,433 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 293 nodes · 514 edges · 16 communities (14 shown, 2 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6bd59758`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]

## God Nodes (most connected - your core abstractions)
1. `MercadoLibreClient` - 20 edges
2. `MlScraperService` - 19 edges
3. `compilerOptions` - 19 edges
4. `ScraperHealthService` - 16 edges
5. `CategoryFetchService` - 12 edges
6. `ScraperController` - 12 edges
7. `AdaptiveLimiter` - 10 edges
8. `CLAUDE.md — ml-scraper (worker)` - 10 edges
9. `jest` - 9 edges
10. `ExchangeRateClient` - 8 edges

## Surprising Connections (you probably didn't know these)
- `EnrichBody` --references--> `EnrichInput`  [EXTRACTED]
  src/worker/scraper.controller.ts → src/worker/enriched-product.dto.ts
- `MercadoLibreClient` --references--> `MlRateLimiter`  [EXTRACTED]
  src/adapters/mercadolibre/mercadolibre.client.ts → src/adapters/mercadolibre/ml-rate-limiter.ts
- `load()` --calls--> `AppConfig`  [EXTRACTED]
  src/config/app.config.spec.ts → src/config/app.config.ts

## Import Cycles
- None detected.

## Communities (16 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.09
Nodes (13): ExchangeModule, ErApiResponse, ExchangeRateClient, formatYmd(), mockedAxios, formatYmd(), HolidaysClient, NagerHoliday (+5 more)

### Community 1 - "Community 1"
Cohesion: 0.11
Nodes (26): categoryUrl(), EMPTY_ENRICHMENT, itemIdFromUrl(), parseBuyBoxPrice(), parseCategoryHtml(), parseMagnitudeCount(), parseProductBasicsFromHtml(), parseProductPageHtml() (+18 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (28): dependencies, axios, cheerio, @nestjs/common, @nestjs/config, @nestjs/core, @nestjs/platform-express, p-limit (+20 more)

### Community 3 - "Community 3"
Cohesion: 0.14
Nodes (13): Architecture (`src/`), Billing-aware retries & circuit breaker, CLAUDE.md — ml-scraper (worker), Code conventions, Commands, Concurrency cap (adaptive AIMD), Decodo request shape, HTTP endpoints (internal — called by ml-service) (+5 more)

### Community 4 - "Community 4"
Cohesion: 0.11
Nodes (8): AllExceptionsFilter, ErrorBody, AppConfig, load(), AppController, AppModule, logger, WorkerModule

### Community 5 - "Community 5"
Cohesion: 0.11
Nodes (7): BIG, SMALL, CircuitBreakerOpenError, DecodoAccountError, FailureSample, ScraperAbortError, ScraperHealthService

### Community 6 - "Community 6"
Cohesion: 0.10
Nodes (19): compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration, emitDecoratorMetadata, esModuleInterop, experimentalDecorators, forceConsistentCasingInFileNames (+11 more)

### Community 7 - "Community 7"
Cohesion: 0.17
Nodes (8): errorMessage(), MercadoLibreClient, mockedAxios, tokenResponse, TokenResponse, mlBackoffMs(), MlRateLimiter, sleep()

### Community 9 - "Community 9"
Cohesion: 0.20
Nodes (10): jest, collectCoverageFrom, coverageDirectory, moduleFileExtensions, rootDir, setupFilesAfterEnv, testEnvironment, testRegex (+2 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (16): currencyForSite(), ScrapedProduct, siteIdFromUrl(), CategoryFetchService, mergeEnriched(), toEnrichInput(), toUsd(), EnrichedProduct (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 14 - "Community 14"
Cohesion: 0.16
Nodes (7): AcquireToken, AdaptiveLimiter, AdaptiveLimiterOptions, clamp(), RequestOutcome, SCRAPER_SEMAPHORE, scraperSemaphoreProvider

### Community 15 - "Community 15"
Cohesion: 0.50
Nodes (3): Endpoints (internal — called by ml-service), ml-scraper (worker), Run

## Knowledge Gaps
- **92 isolated node(s):** `$schema`, `collection`, `sourceRoot`, `deleteOutDir`, `name` (+87 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `MercadoLibreClient` connect `Community 7` to `Community 0`, `Community 10`, `Community 5`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Why does `MlScraperService` connect `Community 1` to `Community 0`, `Community 10`, `Community 5`, `Community 14`?**
  _High betweenness centrality (0.051) - this node is a cross-community bridge._
- **Why does `ScraperHealthService` connect `Community 5` to `Community 0`, `Community 1`, `Community 10`, `Community 14`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **What connects `$schema`, `collection`, `sourceRoot` to the rest of the system?**
  _92 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.09032258064516129 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.10685249709639953 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._