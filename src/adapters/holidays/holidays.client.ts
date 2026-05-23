import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

const TIMEOUT_MS = 10_000;
const BASE_URL = 'https://date.nager.at/api/v3';

const SITE_TO_ISO2: Record<string, string> = {
  MLA: 'AR',
  MLB: 'BR',
  MLC: 'CL',
  MLM: 'MX',
  MCO: 'CO',
  MLU: 'UY',
  MLP: 'PE',
  MLV: 'VE',
  MLD: 'DO',
  MLE: 'EC',
};

interface NagerHoliday {
  date: string;
  localName: string;
  name: string;
}

@Injectable()
export class HolidaysClient {
  private readonly logger = new Logger(HolidaysClient.name);
  private readonly http: AxiosInstance;
  private readonly cache = new Map<string, Map<string, string>>();
  private readonly warnedSites = new Set<string>();

  constructor() {
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'MarketAnalysis/2.0' },
    });
  }

  async getHolidayName(date: Date, siteId: string): Promise<string | null> {
    const iso2 = SITE_TO_ISO2[siteId];
    if (!iso2) {
      if (!this.warnedSites.has(siteId)) {
        this.logger.warn(`No ISO2 mapping for siteId=${siteId}; holiday lookups disabled`);
        this.warnedSites.add(siteId);
      }
      return null;
    }

    const year = date.getUTCFullYear();
    const cacheKey = `${year}-${iso2}`;
    let yearMap = this.cache.get(cacheKey);

    if (!yearMap) {
      yearMap = await this.fetchYear(year, iso2);
      this.cache.set(cacheKey, yearMap);
    }

    const dayKey = formatYmd(date);
    return yearMap.get(dayKey) ?? null;
  }

  private async fetchYear(year: number, iso2: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const resp = await this.http.get<NagerHoliday[]>(`/PublicHolidays/${year}/${iso2}`);
      for (const h of resp.data) {
        map.set(h.date, h.localName ?? h.name);
      }
      this.logger.log(`Fetched ${map.size} holidays for ${iso2} ${year}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to fetch holidays for ${iso2} ${year}: ${msg}`);
    }
    return map;
  }
}

function formatYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
