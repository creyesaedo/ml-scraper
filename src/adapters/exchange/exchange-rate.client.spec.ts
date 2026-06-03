import axios from 'axios';
import { ExchangeRateClient } from './exchange-rate.client';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeClient() {
  const http = { get: jest.fn() };
  (mockedAxios.create as jest.Mock).mockReturnValue(http);
  return { client: new ExchangeRateClient(), http };
}

const success = (rates: Record<string, number>) => ({
  data: { result: 'success', base_code: 'USD', rates },
});

describe('ExchangeRateClient', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the rate for a known currency', async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValue(success({ CLP: 950.5, COP: 4100 }));
    expect(await client.getRate('CLP', new Date('2026-06-03T12:00:00Z'))).toBe(950.5);
  });

  it('returns 1 for USD without hitting the network', async () => {
    const { client, http } = makeClient();
    expect(await client.getRate('USD', new Date('2026-06-03T12:00:00Z'))).toBe(1);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('returns null for an unknown currency', async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValue(success({ CLP: 950.5 }));
    expect(await client.getRate('ZZZ', new Date('2026-06-03T12:00:00Z'))).toBeNull();
  });

  it('caches per day: one network call for repeated lookups', async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValue(success({ CLP: 950.5, ARS: 900 }));

    await client.getRate('CLP', new Date('2026-06-03T00:00:00Z'));
    await client.getRate('ARS', new Date('2026-06-03T23:00:00Z'));

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get).toHaveBeenCalledWith('/latest/USD');
  });

  it('degrades to null (and caches it) on network failure', async () => {
    const { client, http } = makeClient();
    http.get.mockRejectedValue(new Error('timeout'));

    expect(await client.getRate('CLP', new Date('2026-06-03T00:00:00Z'))).toBeNull();
    expect(await client.getRate('ARS', new Date('2026-06-03T01:00:00Z'))).toBeNull();
    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('returns null on a non-success body', async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValue({ data: { result: 'error', rates: null } });
    expect(await client.getRate('CLP', new Date('2026-06-03T00:00:00Z'))).toBeNull();
  });

  it('returns null for a non-positive rate', async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValue(success({ CLP: 0 }));
    expect(await client.getRate('CLP', new Date('2026-06-03T00:00:00Z'))).toBeNull();
  });
});
