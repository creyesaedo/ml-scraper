import axios from 'axios';
import { MercadoLibreClient } from './mercadolibre.client';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeClient(creds: { id?: string; secret?: string } = {}) {
  const http = { get: jest.fn(), post: jest.fn() };
  (mockedAxios.create as jest.Mock).mockReturnValue(http);
  const config = {
    mlBaseUrl: 'https://api.mercadolibre.com',
    mlClientId: creds.id ?? '',
    mlClientSecret: creds.secret ?? '',
    // limitedGet reads these: a high rate keeps the limiter from sleeping in tests,
    // and a non-undefined retry budget lets the request loop actually run (an
    // undefined budget makes `attempt <= undefined` false → the loop is skipped).
    mlApiRateLimitPerSec: 1000,
    mlApiMaxRetries: 2,
  } as any;
  const client = new MercadoLibreClient(config);
  return { client, http };
}

const tokenResponse = { data: { access_token: 'tok123', expires_in: 3600 } };

describe('MercadoLibreClient', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('without credentials', () => {
    it('does not request a token and calls endpoints unauthenticated', async () => {
      const { client, http } = makeClient();
      http.get.mockResolvedValue({ data: [{ id: 'MLC', name: 'Chile' }] });

      const sites = await client.getSites();

      expect(sites).toEqual([{ id: 'MLC', name: 'Chile' }]);
      expect(http.post).not.toHaveBeenCalled();
      expect(http.get).toHaveBeenCalledWith('/sites', { headers: {} });
    });
  });

  describe('with credentials', () => {
    it('fetches a token once and reuses it (Bearer header attached)', async () => {
      const { client, http } = makeClient({ id: 'cid', secret: 'sec' });
      http.post.mockResolvedValue(tokenResponse);
      http.get.mockResolvedValue({ data: [] });

      await client.getSiteCategories('MLC');
      await client.getSiteCategories('MLA');

      expect(http.post).toHaveBeenCalledTimes(1);
      expect(http.get).toHaveBeenLastCalledWith('/sites/MLA/categories', {
        headers: { Authorization: 'Bearer tok123' },
      });
    });

    it('wraps a token failure in a clear error', async () => {
      const { client, http } = makeClient({ id: 'cid', secret: 'sec' });
      http.post.mockRejectedValue(new Error('connection refused'));

      await expect(client.getSites()).rejects.toThrow(/MercadoLibre authentication failed/);
    });
  });

  describe('getCategory', () => {
    it('returns the category data', async () => {
      const { client, http } = makeClient();
      http.get.mockResolvedValue({ data: { name: 'Tools', children_categories: [] } });
      const cat = await client.getCategory('MLC1');
      expect(cat).toEqual({ name: 'Tools', children_categories: [] });
    });

    it('returns null when the request fails', async () => {
      const { client, http } = makeClient();
      http.get.mockRejectedValue(new Error('404'));
      expect(await client.getCategory('MLC1')).toBeNull();
    });
  });

  describe('getCatalogProduct', () => {
    it('returns date_created and a null buy-box winner when absent', async () => {
      const { client, http } = makeClient();
      http.get.mockResolvedValue({ data: { date_created: '2022-05-01T00:00:00Z', extra: 1 } });
      expect(await client.getCatalogProduct('MLC9')).toEqual({
        date_created: '2022-05-01T00:00:00Z',
        buy_box_winner_item_id: null,
      });
    });

    it('extracts the buy-box winner item id when present', async () => {
      const { client, http } = makeClient();
      http.get.mockResolvedValue({
        data: {
          date_created: '2022-05-01T00:00:00Z',
          buy_box_winner: { item_id: 'MCO3975198228' },
        },
      });
      expect(await client.getCatalogProduct('MCO44915739')).toEqual({
        date_created: '2022-05-01T00:00:00Z',
        buy_box_winner_item_id: 'MCO3975198228',
      });
    });

    it('returns null when the request fails', async () => {
      const { client, http } = makeClient();
      http.get.mockRejectedValue(new Error('boom'));
      expect(await client.getCatalogProduct('MLC9')).toBeNull();
    });
  });

  describe('getUserProduct', () => {
    it('returns date_created from the user-products endpoint', async () => {
      const { client, http } = makeClient();
      http.get.mockResolvedValue({ data: { date_created: '2024-01-03T04:58:48.106+0000', name: 'x' } });
      expect(await client.getUserProduct('MLCU57917080')).toEqual({
        date_created: '2024-01-03T04:58:48.106+0000',
      });
      expect(http.get).toHaveBeenCalledWith('/user-products/MLCU57917080', expect.anything());
    });

    it('returns a null date when the field is absent', async () => {
      const { client, http } = makeClient();
      http.get.mockResolvedValue({ data: { name: 'x' } });
      expect(await client.getUserProduct('MLCU1')).toEqual({ date_created: null });
    });

    it('returns null when the request fails', async () => {
      const { client, http } = makeClient();
      http.get.mockRejectedValue(new Error('boom'));
      expect(await client.getUserProduct('MLCU1')).toBeNull();
    });
  });

  describe('getItemDate', () => {
    it('returns date_created from the description sub-resource', async () => {
      const { client, http } = makeClient();
      http.get.mockResolvedValue({ data: { date_created: '2021-09-02T18:00:24.000Z', text: 'x' } });
      expect(await client.getItemDate('MLA1100317427')).toEqual({
        date_created: '2021-09-02T18:00:24.000Z',
      });
      expect(http.get).toHaveBeenCalledWith('/items/MLA1100317427/description', expect.anything());
    });

    it('returns null when the request fails', async () => {
      const { client, http } = makeClient();
      http.get.mockRejectedValue(new Error('boom'));
      expect(await client.getItemDate('MLA1')).toBeNull();
    });
  });
});
