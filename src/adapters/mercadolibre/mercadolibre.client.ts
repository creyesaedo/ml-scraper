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

@Injectable()
export class MercadoLibreClient {
  private readonly logger = new Logger(MercadoLibreClient.name);
  private readonly http: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0; // performance.now() — monotonic, immune to clock changes

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

  async getSites(): Promise<Array<{ id: string; name: string }>> {
    await this.ensureToken();
    const resp = await this.http.get<Array<{ id: string; name: string }>>('/sites', {
      headers: this.authHeaders(),
    });
    return resp.data;
  }

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

  async searchProducts(
    siteId: string,
    categoryId: string,
    limit: number = 10,
    sort: string = 'sold_quantity',
  ): Promise<unknown> {
    await this.ensureToken();
    const resp = await this.http.get(`/sites/${siteId}/search`, {
      params: { category: categoryId, sort, limit },
      headers: this.authHeaders(),
    });
    return resp.data;
  }

  async getItemsBulk(itemIds: string[]): Promise<unknown[]> {
    await this.ensureToken();
    const resp = await this.http.get<unknown[]>('/items', {
      params: { ids: itemIds.join(',') },
      headers: this.authHeaders(),
    });
    return resp.data;
  }

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
