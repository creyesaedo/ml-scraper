import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import appConfig from '../../config/app.config';

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
    const resp = await this.http.post<TokenResponse>(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.mlClientId,
        client_secret: this.config.mlClientSecret,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
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
    await this.ensureToken();
    const resp = await this.http.get<Array<{ id: string; name: string }>>('/sites', {
      headers: this.authHeaders(),
    });
    return resp.data;
  }

  /** Returns the top-level (root) categories for a given site. */
  async getSiteCategories(
    siteId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    await this.ensureToken();
    const resp = await this.http.get<Array<{ id: string; name: string }>>(
      `/sites/${siteId}/categories`,
      { headers: this.authHeaders() },
    );
    return resp.data;
  }

  /**
   * Fetches a single category (its name and child categories) by ML id.
   * Returns null if the request fails, so callers can skip it without crashing.
   */
  async getCategory(
    categoryId: string,
  ): Promise<{ name: string; children_categories: Array<{ id: string; name: string }> } | null> {
    await this.ensureToken();
    try {
      const resp = await this.http.get<{
        name: string;
        children_categories: Array<{ id: string; name: string }>;
      }>(`/categories/${categoryId}`, { headers: this.authHeaders() });
      return resp.data;
    } catch {
      return null;
    }
  }

  /**
   * Fetches a catalog product by its catalog id, used to read `date_created`
   * (when the product was first listed). Returns null on failure so a single
   * missing product never aborts the sync.
   */
  async getCatalogProduct(catalogId: string): Promise<{ date_created: string } | null> {
    await this.ensureToken();
    try {
      const resp = await this.http.get<{ date_created: string }>(
        `/products/${catalogId}`,
        { headers: this.authHeaders() },
      );
      return { date_created: resp.data.date_created };
    } catch {
      return null;
    }
  }
}
