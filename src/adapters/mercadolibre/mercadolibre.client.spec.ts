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
    it('returns only date_created', async () => {
      const { client, http } = makeClient();
      http.get.mockResolvedValue({ data: { date_created: '2022-05-01T00:00:00Z', extra: 1 } });
      expect(await client.getCatalogProduct('MLC9')).toEqual({
        date_created: '2022-05-01T00:00:00Z',
      });
    });

    it('returns null when the request fails', async () => {
      const { client, http } = makeClient();
      http.get.mockRejectedValue(new Error('boom'));
      expect(await client.getCatalogProduct('MLC9')).toBeNull();
    });
  });
});
