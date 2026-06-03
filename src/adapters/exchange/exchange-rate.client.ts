import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

const TIMEOUT_MS = 10_000;
// Free, keyless tier of exchangerate-api.com. USD-based latest rates; covers
// every LatAm currency we need (ARS, CLP, COP, PEN, UYU, DOP, VES, BRL, MXN).
const BASE_URL = 'https://open.er-api.com/v6';

interface ErApiResponse {
  result: string;
  base_code: string;
  rates: Record<string, number>;
}

/**
 * Fetches USD-based FX rates (local units per 1 USD) so each product snapshot
 * can store its price converted to dollars.
 *
 * Rates are cached in memory per day (keyed by "YYYY-MM-DD"): the first lookup
 * of a run hits the network, every later lookup that same day is served from
 * the cache, so a full multi-site run makes at most one network call. The cache
 * lives only for the process lifetime.
 *
 * Failure is soft: an unreachable provider, a non-success body, or an unknown
 * currency all return null. The caller then leaves the USD columns null and the
 * sync continues — FX is secondary to saving the snapshot.
 */
@Injectable()
export class ExchangeRateClient {
  private readonly logger = new Logger(ExchangeRateClient.name);
  private readonly http: AxiosInstance;
  // Cache keyed by "YYYY-MM-DD" → { CCY → rate per 1 USD }. null = fetch failed
  // that day (cached so we don't retry the dead endpoint on every product).
  private readonly cache = new Map<string, Record<string, number> | null>();

  constructor() {
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'MarketAnalysis/2.0' },
    });
  }

  /**
   * Returns the rate (local units per 1 USD) for a currency on the given date,
   * or null if the currency is unknown or the fetch failed. USD → 1.
   */
  async getRate(currency: string, date: Date): Promise<number | null> {
    if (currency === 'USD') return 1;

    const key = formatYmd(date);
    let rates = this.cache.get(key);
    if (rates === undefined) {
      rates = await this.fetchRates();
      this.cache.set(key, rates);
    }

    if (!rates) return null;

    const rate = rates[currency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      this.logger.warn(`No FX rate for ${currency}`);
      return null;
    }
    return rate;
  }

  /**
   * Downloads the latest USD-based rates. On a non-success body or any network
   * error it logs and returns null so the sync continues without USD columns.
   */
  private async fetchRates(): Promise<Record<string, number> | null> {
    try {
      const resp = await this.http.get<ErApiResponse>('/latest/USD');
      if (resp.data.result !== 'success' || !resp.data.rates) {
        this.logger.error(`FX provider returned non-success: ${resp.data.result}`);
        return null;
      }
      this.logger.log(`Fetched ${Object.keys(resp.data.rates).length} FX rates (base USD)`);
      return resp.data.rates;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to fetch FX rates: ${msg}`);
      return null;
    }
  }
}

/** Formats a date as "YYYY-MM-DD" in UTC. */
function formatYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
