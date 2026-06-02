import {
  EMPTY_ENRICHMENT,
  SITE_DOMAINS,
  SITE_GEO,
  categoryUrl,
  parseCategoryHtml,
  parseProductPageHtml,
  siteHasBestSellers,
} from './ml-parsers';

describe('ml-parsers', () => {
  describe('categoryUrl', () => {
    it('builds a Spanish best-sellers URL for a normal site', () => {
      expect(categoryUrl('MLC', 'MLC1648')).toBe(
        'https://www.mercadolibre.cl/mas-vendidos/MLC1648',
      );
    });

    it('uses the Portuguese slug for Brazil', () => {
      expect(categoryUrl('MLB', 'MLB1648')).toBe(
        'https://www.mercadolivre.com.br/mais-vendidos/MLB1648',
      );
    });

    it('falls back to the Argentine domain + Spanish slug for an unknown site', () => {
      expect(categoryUrl('XXX', 'XXX1')).toBe(
        'https://www.mercadolibre.com.ar/mas-vendidos/XXX1',
      );
    });
  });

  describe('siteHasBestSellers', () => {
    it('returns false for reduced markets (MLD, MLV)', () => {
      expect(siteHasBestSellers('MLD')).toBe(false);
      expect(siteHasBestSellers('MLV')).toBe(false);
    });

    it('returns true for normal sites', () => {
      expect(siteHasBestSellers('MLC')).toBe(true);
      expect(siteHasBestSellers('MLA')).toBe(true);
    });
  });

  describe('site lookup tables', () => {
    it('has a geo code for every known domain', () => {
      for (const site of Object.keys(SITE_DOMAINS)) {
        expect(SITE_GEO[site]).toBeDefined();
        expect(SITE_GEO[site]).toHaveLength(2);
      }
    });
  });

  describe('parseCategoryHtml', () => {
    const item = (name: string, href: string, price: string) =>
      `<li class="ui-search-layout__item">
         <a class="poly-component__title" href="${href}">${name}</a>
         <span class="andes-money-amount__fraction">${price}</span>
       </li>`;

    it('extracts products with name, price (digits only), catalog id, url and ranking', () => {
      const html = `<ul>
        ${item('iPhone 15', 'https://www.mercadolibre.cl/iphone/p/MLC123456#position=1', '1.299.990')}
        ${item('Galaxy S24', 'https://www.mercadolibre.cl/galaxy/p/MLC777888', '899.000')}
      </ul>`;

      const products = parseCategoryHtml(html);

      expect(products).toHaveLength(2);
      expect(products[0]).toEqual({
        name: 'iPhone 15',
        price: '1299990',
        catalog_id: 'MLC123456',
        product_url: 'https://www.mercadolibre.cl/iphone/p/MLC123456',
        ranking_position: 1,
      });
      expect(products[1].catalog_id).toBe('MLC777888');
      expect(products[1].ranking_position).toBe(2);
    });

    it('sets catalog_id null for listings without a /p/ catalog page', () => {
      const html = item('Producto suelto', 'https://www.mercadolibre.cl/up/MLU999', '5.000');
      const products = parseCategoryHtml(html);
      expect(products[0].catalog_id).toBeNull();
      expect(products[0].price).toBe('5000');
    });

    it('skips items with no name', () => {
      const html = `<li class="ui-search-layout__item">
        <a class="poly-component__title" href="/x/p/MLC1"></a>
        <span class="andes-money-amount__fraction">10</span>
      </li>`;
      expect(parseCategoryHtml(html)).toHaveLength(0);
    });

    it('returns an empty array when there are no matching items', () => {
      expect(parseCategoryHtml('<html><body>nothing here</body></html>')).toEqual([]);
    });

    it('defaults price to "0" when no price node is present', () => {
      const html = `<li class="ui-search-layout__item">
        <a class="poly-component__title" href="/x/p/MLC1">Sin precio</a>
      </li>`;
      expect(parseCategoryHtml(html)[0].price).toBe('0');
    });
  });

  describe('parseProductPageHtml — sold_count', () => {
    it('parses a plain count', () => {
      expect(parseProductPageHtml('+1.234 vendidos').sold_count).toBe(1234);
    });

    it('parses thousands ("mil")', () => {
      expect(parseProductPageHtml('+5 mil vendidos').sold_count).toBe(5000);
    });

    it('parses fractional thousands with a decimal comma', () => {
      expect(parseProductPageHtml('+2,5 mil vendidos').sold_count).toBe(2500);
    });

    it('parses millions ("millón")', () => {
      expect(parseProductPageHtml('+2 millón vendidos').sold_count).toBe(2_000_000);
    });

    it('is null when the badge is absent', () => {
      expect(parseProductPageHtml('no sales badge').sold_count).toBeNull();
    });
  });

  describe('parseProductPageHtml — full page', () => {
    const html = [
      '"reviews":{"rating":4.5,"amount":120}',
      '"id":"Marca","text":"Apple"',
      '"date_created":"2023-01-15T10:00:00.000Z"',
      '"catalogProductId":"MLC987654"',
      '"categoryId":"MLC1055"',
      'Publicación #123456789',
      '"previous_price":{"value":1599990}',
      '"discount":{"value":34}',
      '"icon_id":"vpp_full_icon"',
      '"listing_type_id":"gold_pro"',
      '"cbt_summary":{}',
      '"seller_id":12345',
      '"nickname":"TIENDA_OFICIAL"',
      '"official_store_id":7',
      '"power_seller_status":"platinum"',
      '+100 productos',
      '+5 mil ventas',
      '+5 mil vendidos',
    ].join(' ');

    const e = parseProductPageHtml(html);

    it('extracts reviews', () => {
      expect(e.rating).toBe(4.5);
      expect(e.review_count).toBe(120);
    });
    it('extracts brand', () => expect(e.brand).toBe('Apple'));
    it('extracts date_created', () =>
      expect(e.date_created_from_page).toBe('2023-01-15T10:00:00.000Z'));
    it('extracts catalog product id', () =>
      expect(e.catalog_product_id_from_page).toBe('MLC987654'));
    it('extracts leaf category id', () => expect(e.leaf_category_id).toBe('MLC1055'));
    it('extracts the public listing id', () => expect(e.ml_public_id).toBe('123456789'));
    it('extracts original price', () => expect(e.original_price).toBe(1599990));
    it('extracts discount percentage', () => expect(e.discount_pct).toBe(34));
    it('detects shipping type full (highest priority)', () =>
      expect(e.shipping_type).toBe('full'));
    it('extracts listing type id', () => expect(e.listing_type_id).toBe('gold_pro'));
    it('flags cross-border listings', () => expect(e.is_cbt).toBe(true));

    it('extracts the seller block', () => {
      expect(e.seller_ml_id).toBe('12345');
      expect(e.seller_nickname).toBe('TIENDA_OFICIAL');
      expect(e.seller_is_official_store).toBe(true);
      expect(e.seller_power_status).toBe('platinum');
      expect(e.seller_total_products).toBe(100);
      expect(e.seller_total_sales).toBe(5000);
    });
  });

  describe('parseProductPageHtml — shipping precedence', () => {
    it('detects free shipping', () => {
      const e = parseProductPageHtml('"shipping":{"text":"Envío gratis"}');
      expect(e.shipping_type).toBe('free');
    });

    it('detects standard shipping', () => {
      const e = parseProductPageHtml('"shipping":{"text":"Envío a acordar"}');
      expect(e.shipping_type).toBe('standard');
    });

    it('is null when there is no shipping block', () => {
      expect(parseProductPageHtml('nothing').shipping_type).toBeNull();
    });
  });

  describe('parseProductPageHtml — empty input', () => {
    it('returns the empty-enrichment shape (never throws)', () => {
      expect(parseProductPageHtml('')).toEqual(EMPTY_ENRICHMENT);
    });
  });
});
