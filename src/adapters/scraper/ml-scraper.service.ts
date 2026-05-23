import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import appConfig from '../../config/app.config';

export interface ScrapedProduct {
  name: string;
  price: string;
  catalog_id: string | null;
  listing_id: string | null;
  product_url: string | null;
}

export interface ProductEnrichment {
  sold_count: number | null;
  rating: number | null;
  review_count: number | null;
  brand: string | null;
  date_created_from_page: string | null;
  catalog_product_id_from_page: string | null;
  leaf_category_id: string | null;
}

const SITE_DOMAINS: Record<string, string> = {
  MLA: 'mercadolibre.com.ar',
  MLB: 'mercadolibre.com.br',
  MLM: 'mercadolibre.com.mx',
  MLC: 'mercadolibre.cl',
  MCO: 'mercadolibre.com.co',
  MLU: 'mercadolibre.com.uy',
  MLP: 'mercadolibre.com.pe',
  MLV: 'mercadolibre.com.ve',
  MLD: 'mercadolibre.com.do',
  MLE: 'mercadolibre.com.ec',
};

export const EMPTY_ENRICHMENT: ProductEnrichment = {
  sold_count: null,
  rating: null,
  review_count: null,
  brand: null,
  date_created_from_page: null,
  catalog_product_id_from_page: null,
  leaf_category_id: null,
};

@Injectable()
export class MlScraperService {
  private readonly logger = new Logger(MlScraperService.name);

  constructor(
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  /**
   * Single Scraping Browser session that scrapes the category page AND all product pages.
   * Reuses one browser context for all navigations so JS bundles are cached in-browser
   * (only downloaded once instead of N times). Resource blocking is applied at context
   * level so every page inherits it; product pages get an even stricter page-level block
   * (only HTML document allowed) since their data is server-rendered into the initial HTML.
   */
  async scrapeCategoryWithProducts(
    siteId: string,
    categoryMlId: string,
    productConcurrency = 8,
  ): Promise<{
    products: ScrapedProduct[];
    enrichmentsByUrl: Map<string, ProductEnrichment>;
  }> {
    const enrichmentsByUrl = new Map<string, ProductEnrichment>();

    if (!this.config.brightdataScrapingBrowserWs) {
      this.logger.error('BRIGHTDATA_SCRAPING_BROWSER_WS is not configured');
      return { products: [], enrichmentsByUrl };
    }

    const domain = SITE_DOMAINS[siteId] ?? 'mercadolibre.com.ar';
    const categoryUrl = `https://www.${domain}/mas-vendidos/${categoryMlId}`;

    let browser: Browser | undefined;
    try {
      browser = await chromium.connectOverCDP(this.config.brightdataScrapingBrowserWs);
      const context = await browser.newContext();
      await this.applyResourceBlocking(context);

      // Step 1: scrape the category page
      let products: ScrapedProduct[] = [];
      const categoryPage = await context.newPage();
      try {
        await categoryPage.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await categoryPage
          .waitForSelector('li.ui-search-layout__item', { timeout: 15_000 })
          .catch(() => {});

        let html: string;
        try {
          html = await categoryPage.content();
        } catch {
          await categoryPage.waitForTimeout(3000);
          html = await categoryPage.content();
        }
        products = this.parseCategoryHtml(html);

        if (!products.length) {
          this.logger.warn(`[${siteId}] No products found for ${categoryMlId}`);
        } else {
          this.logger.log(`[${siteId}] ${categoryMlId} → ${products.length} products`);
        }
      } catch (err) {
        this.logger.error(
          `[${siteId}] Error scraping category ${categoryMlId}: ${(err as Error).message}`,
        );
      } finally {
        await categoryPage.close().catch(() => {});
      }

      if (!products.length) return { products, enrichmentsByUrl };

      // Step 2: scrape product pages in parallel within the same context (shared JS cache)
      const limit = pLimit(productConcurrency);
      await Promise.all(
        products.map((p) =>
          limit(async () => {
            if (!p.product_url) return;
            const enrichment = await this.scrapeProductPageInContext(context, p.product_url);
            enrichmentsByUrl.set(p.product_url, enrichment);
          }),
        ),
      );

      return { products, enrichmentsByUrl };
    } catch (err) {
      this.logger.error(
        `[${siteId}] Fatal browser error for ${categoryMlId}: ${(err as Error).message}`,
      );
      return { products: [], enrichmentsByUrl };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  private async scrapeProductPageInContext(
    context: BrowserContext,
    productUrl: string,
  ): Promise<ProductEnrichment> {
    const page = await context.newPage();
    try {
      await this.applyStrictBlockingForProductPage(page);
      await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      let html: string;
      try {
        html = await page.content();
      } catch {
        await page.waitForTimeout(2000);
        html = await page.content();
      }

      if (html.length < 50_000) {
        this.logger.warn(`Product page too small (${html.length}b): ${productUrl}`);
        return EMPTY_ENRICHMENT;
      }

      return this.parseProductPageHtml(html);
    } catch (err) {
      this.logger.warn(
        `Error scraping product page ${productUrl}: ${(err as Error).message}`,
      );
      return EMPTY_ENRICHMENT;
    } finally {
      await page.close().catch(() => {});
    }
  }

  private async applyStrictBlockingForProductPage(page: Page): Promise<void> {
    // Page-level routes override context-level routes for this page only.
    // Product page data (sold_count, rating, reviews, brand, catalogProductId,
    // categoryId) is server-rendered into inline <script> tags in the document
    // HTML — we extract via regex on the raw string, not the rendered DOM.
    // So we block EVERYTHING except the main document.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'document') return route.continue();
      return route.abort();
    });
  }

  private async applyResourceBlocking(context: BrowserContext): Promise<void> {
    // Heavy media — not needed for HTML data extraction
    await context.route('**/*.{png,jpg,jpeg,webp,gif,svg,ico,avif,bmp}', (route) => route.abort());
    await context.route('**/*.{woff,woff2,ttf,eot,otf}', (route) => route.abort());
    await context.route('**/*.{mp4,webm,ogg,mp3,wav,m4a}', (route) => route.abort());
    // Tracking / analytics — irrelevant for data extraction
    await context.route('**/google-analytics.com/**', (route) => route.abort());
    await context.route('**/googletagmanager.com/**', (route) => route.abort());
    await context.route('**/facebook.net/**', (route) => route.abort());
    await context.route('**/snoopy.mercadolibre.com/**', (route) => route.abort());
    await context.route('**/criteo.com/**', (route) => route.abort());
    await context.route('**/doubleclick.net/**', (route) => route.abort());
  }

  private parseCategoryHtml(html: string): ScrapedProduct[] {
    try {
      const $ = cheerio.load(html);
      const products: ScrapedProduct[] = [];

      $('li.ui-search-layout__item').each((_i, el) => {
        const name = $(el).find('.poly-component__title').text().trim();
        const priceRaw = $(el)
          .find('.andes-money-amount__fraction')
          .first()
          .text()
          .trim()
          .replace(/\./g, '');

        const href = $(el).find('a.poly-component__title').attr('href') ?? '';
        const catalogMatch = href.match(/\/p\/(ML[A-Z][0-9]+)/);
        const widMatch = href.match(/[?&]wid=(ML[A-Z][0-9]+)/);

        if (name) {
          products.push({
            name,
            price: priceRaw || '0',
            catalog_id: catalogMatch?.[1] ?? null,
            listing_id: widMatch?.[1] ?? null,
            product_url: href ? href.split('#')[0] : null,
          });
        }
      });

      return products;
    } catch (err) {
      this.logger.error(`HTML parse error: ${(err as Error).message}`);
      return [];
    }
  }

  private parseProductPageHtml(html: string): ProductEnrichment {
    let sold_count: number | null = null;
    const soldMatch = html.match(/\+([\d.,]+)\s*(mil(?:l[oó]n)?)?\s*vendidos/i);
    if (soldMatch) {
      const raw = parseFloat(soldMatch[1].replace(/\./g, '').replace(',', '.'));
      const suffix = (soldMatch[2] ?? '').toLowerCase();
      if (suffix.startsWith('mill')) sold_count = Math.round(raw * 1_000_000);
      else if (suffix === 'mil') sold_count = Math.round(raw * 1_000);
      else sold_count = Math.round(raw);
    }

    let rating: number | null = null;
    let review_count: number | null = null;
    const reviewsMatch = html.match(
      /"reviews"\s*:\s*\{"rating"\s*:\s*([\d.]+)\s*,\s*"amount"\s*:\s*(\d+)/,
    );
    if (reviewsMatch) {
      rating = parseFloat(reviewsMatch[1]);
      review_count = parseInt(reviewsMatch[2], 10);
    }

    let brand: string | null = null;
    const brandMatch = html.match(/"id"\s*:\s*"Marca"\s*,\s*"text"\s*:\s*"([^"]+)"/);
    if (brandMatch) brand = brandMatch[1];

    let date_created_from_page: string | null = null;
    const dateMatch = html.match(/"date_created"\s*:\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/);
    if (dateMatch) date_created_from_page = dateMatch[1];

    let catalog_product_id_from_page: string | null = null;
    const catalogPidMatch = html.match(/"catalogProductId"\s*:\s*"(ML[A-Z][0-9]+)"/);
    if (catalogPidMatch) catalog_product_id_from_page = catalogPidMatch[1];

    let leaf_category_id: string | null = null;
    const categoryIdMatch = html.match(/"categoryId"\s*:\s*"(ML[A-Z][0-9]+)"/);
    if (categoryIdMatch) leaf_category_id = categoryIdMatch[1];

    return { sold_count, rating, review_count, brand, date_created_from_page, catalog_product_id_from_page, leaf_category_id };
  }
}
