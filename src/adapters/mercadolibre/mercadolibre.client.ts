import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import appConfig from '../../config/app.config';
import { ReviewLevels } from '../../worker/enriched-product.dto';
import { MlRateLimiter, mlBackoffMs, sleep } from './ml-rate-limiter';

const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const TOKEN_MARGIN_MS = 60_000;
const TIMEOUT_MS = 30_000;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Thin wrapper around MercadoLibre's official REST API.
 *
 * It handles OAuth2 authentication transparently: every public method calls
 * `ensureToken()` first, which fetches a fresh `client_credentials` token only
 * when the current one is missing or about to expire. Callers never deal with
 * tokens directly. If no client id/secret is configured, requests are sent
 * without auth (only public endpoints will work).
 */
@Injectable()
export class MercadoLibreClient {
  private readonly logger = new Logger(MercadoLibreClient.name);
  private readonly http: AxiosInstance;
  // Global pacer for every ML API GET — keeps the worker under ML's 25 req/s cap.
  private readonly limiter: MlRateLimiter;
  private accessToken: string | null = null;
  // Absolute time (from performance.now(), a monotonic clock) after which the
  // cached token must be renewed. Monotonic so it is immune to system clock changes.
  private tokenExpiresAt: number = 0;

  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {
    this.http = axios.create({
      baseURL: config.mlBaseUrl,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'MarketAnalysis/2.0' },
    });
    this.limiter = new MlRateLimiter(config.mlApiRateLimitPerSec);
  }

  /**
   * GET against the ML API through the global rate limiter, with retry+backoff on
   * 429/5xx/network (and a one-shot token refresh on 401). Throws after the retry
   * budget; the public methods catch and map to null. Genuine 4xx (403/404/410)
   * are NOT retried — they are real verdicts (e.g. a delisted item's visits 404),
   * surfaced immediately. This is what keeps a transient 429 from silently nulling
   * review/visit data.
   */
  private async limitedGet<T>(path: string): Promise<T> {
    await this.ensureToken();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.config.mlApiMaxRetries; attempt++) {
      await this.limiter.acquire();
      try {
        const resp = await this.http.get<T>(path, { headers: this.authHeaders() });
        return resp.data;
      } catch (err) {
        lastErr = err;
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const retryable =
          !axios.isAxiosError(err)
            ? false
            : status === undefined || status === 429 || status === 401 || (status >= 500 && status < 600);
        if (attempt >= this.config.mlApiMaxRetries || !retryable) throw err;
        if (status === 401) {
          // Token expired/invalid: force a refresh, then retry without backoff.
          this.accessToken = null;
          await this.ensureToken();
        } else {
          await sleep(mlBackoffMs(attempt));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Makes sure a valid access token is available before an API call. Returns
   * early if the cached token is still good, or if no credentials are
   * configured (in which case requests go out unauthenticated).
   */
  private async ensureToken(): Promise<void> {
    if (this.accessToken && performance.now() < this.tokenExpiresAt) {
      return;
    }
    if (!this.config.mlClientId || !this.config.mlClientSecret) {
      return;
    }
    let resp: { data: TokenResponse };
    try {
      resp = await this.http.post<TokenResponse>(
        TOKEN_URL,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.config.mlClientId,
          client_secret: this.config.mlClientSecret,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
    } catch (err) {
      // A failed token request means every subsequent ML API call is unusable.
      // Surface a clear, actionable error (bad credentials vs ML/network down)
      // instead of letting a raw axios error bubble up through the sync.
      const msg = errorMessage(err);
      this.logger.error(`Failed to obtain ML OAuth token: ${msg}`);
      throw new Error(`MercadoLibre authentication failed: ${msg}`);
    }
    this.accessToken = resp.data.access_token;
    this.tokenExpiresAt =
      performance.now() + (resp.data.expires_in * 1000 - TOKEN_MARGIN_MS);
    this.logger.debug('ML token renewed');
  }

  private authHeaders(): Record<string, string> {
    if (this.accessToken) {
      return { Authorization: `Bearer ${this.accessToken}` };
    }
    return {};
  }

  /** Lists every MercadoLibre site (one per country, e.g. MLA, MLB, MLC). */
  async getSites(): Promise<Array<{ id: string; name: string }>> {
    return this.limitedGet<Array<{ id: string; name: string }>>('/sites');
  }

  /** Returns the top-level (root) categories for a given site. */
  async getSiteCategories(
    siteId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    return this.limitedGet<Array<{ id: string; name: string }>>(`/sites/${siteId}/categories`);
  }

  /**
   * Fetches a single category (its name, child categories, and the ancestor
   * chain from the site root down to it) by ML id. `path_from_root` is ordered
   * root → leaf, so `[0]` is the site root category — used to attach an
   * on-demand single product to the right root when its leaf isn't cached yet.
   * Returns null if the request fails, so callers can skip it without crashing.
   */
  async getCategory(categoryId: string): Promise<{
    name: string;
    children_categories: Array<{ id: string; name: string }>;
    path_from_root: Array<{ id: string; name: string }>;
  } | null> {
    try {
      return await this.limitedGet<{
        name: string;
        children_categories: Array<{ id: string; name: string }>;
        path_from_root: Array<{ id: string; name: string }>;
      }>(`/categories/${categoryId}`);
    } catch (err) {
      this.logger.warn(`getCategory(${categoryId}) failed: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Fetches a catalog product by its catalog id. Returns `date_created` (when the
   * product was first listed) and the buy-box winner's listing id
   * (`buy_box_winner.item_id`, e.g. "MCO3975198228") — a render-independent
   * fallback for `ml_public_id` when the scraped page didn't yield one. The
   * winner is often null (no active offer), so the caller must handle that.
   * Returns null on failure so a single missing product never aborts the sync.
   */
  async getCatalogProduct(
    catalogId: string,
  ): Promise<{ date_created: string; buy_box_winner_item_id: string | null } | null> {
    try {
      const data = await this.limitedGet<{
        date_created: string;
        buy_box_winner?: { item_id?: string | null } | null;
      }>(`/products/${catalogId}`);
      return {
        date_created: data.date_created,
        buy_box_winner_item_id: data.buy_box_winner?.item_id ?? null,
      };
    } catch (err) {
      this.logger.warn(`getCatalogProduct(${catalogId}) failed: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Fetches a "user product" (the `/up/` id, e.g. "MLCU57917080") via the ML
   * API. Unlike catalog products, `/up/` pages do NOT embed `date_created` in
   * their HTML, so this is the only reliable source of it for them. Returns null
   * on failure so a single missing product never aborts the sync.
   */
  async getUserProduct(
    userProductId: string,
  ): Promise<{ date_created: string | null } | null> {
    try {
      const data = await this.limitedGet<{ date_created?: string | null }>(
        `/user-products/${userProductId}`,
      );
      return { date_created: data.date_created ?? null };
    } catch (err) {
      this.logger.warn(`getUserProduct(${userProductId}) failed: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Fetches a CLASSIC listing's creation date via its public description
   * sub-resource (`/items/{id}/description`). The main `/items/{id}` resource is
   * 403 for non-owners, but the description endpoint is open and carries
   * `date_created` (when the description — effectively the listing — was created).
   * It is a close proxy for the listing date (a seller could re-create the
   * description, but in practice it tracks the original publish date). Returns
   * null on failure so a single missing product never aborts the sync.
   */
  async getItemDate(itemId: string): Promise<{ date_created: string | null } | null> {
    try {
      const data = await this.limitedGet<{ date_created?: string | null }>(
        `/items/${itemId}/description`,
      );
      return { date_created: data.date_created ?? null };
    } catch (err) {
      this.logger.warn(`getItemDate(${itemId}) failed: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Visits in the trailing 7 days for a listing, via the public time-window
   * endpoint (`/items/{id}/visits/time_window?last=1&unit=week`). Unlike
   * `/items/{id}` (403 for non-owners), visits are open for ANY item, so this
   * works for competitors too — a render-independent demand proxy. Returns null
   * on failure so a single missing product never aborts the sync.
   */
  async getItemVisits(itemId: string): Promise<number | null> {
    try {
      const data = await this.limitedGet<{ total_visits?: number | null }>(
        `/items/${itemId}/visits/time_window?last=1&unit=week`,
      );
      return data.total_visits ?? null;
    } catch (err) {
      this.logger.warn(`getItemVisits(${itemId}) failed: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * Aggregated reviews for a listing via the public `/reviews/item/{id}`
   * endpoint: the average rating, the per-listing total, and the per-star
   * breakdown. This is the official-API replacement for the page-scraped
   * rating/review_count — it works for third-party items too. Returns null on
   * failure so a single missing product never aborts the sync.
   */
  async getItemReviews(
    itemId: string,
  ): Promise<{ rating: number | null; total: number | null; levels: ReviewLevels | null } | null> {
    try {
      const data = await this.limitedGet<{
        rating_average?: number | null;
        paging?: { total?: number | null } | null;
        rating_levels?: Partial<ReviewLevels> | null;
      }>(`/reviews/item/${itemId}`);
      // A 200 response is authoritative: an item with no reviews returns
      // `paging.total: 0` + all-zero `rating_levels`. So on success we always
      // yield numbers (total → 0, levels → zero-object), never null. `null` is
      // reserved for a real fetch failure (the catch below), so the caller can
      // tell "0 reviews" (a value to show) apart from "couldn't fetch".
      const lv = data.rating_levels;
      return {
        rating: data.rating_average ?? null,
        total: data.paging?.total ?? 0,
        levels: {
          one_star: lv?.one_star ?? 0,
          two_star: lv?.two_star ?? 0,
          three_star: lv?.three_star ?? 0,
          four_star: lv?.four_star ?? 0,
          five_star: lv?.five_star ?? 0,
        },
      };
    } catch (err) {
      this.logger.warn(`getItemReviews(${itemId}) failed: ${errorMessage(err)}`);
      return null;
    }
  }
}

/**
 * Extracts a concise message from an axios/unknown error. For HTTP errors it
 * prefers the upstream status so a 404 vs 500 vs token failure is visible in
 * the logs without dumping the whole response.
 */
function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    return status ? `HTTP ${status}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
