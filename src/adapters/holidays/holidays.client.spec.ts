import axios from 'axios';
import { HolidaysClient } from './holidays.client';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeClient() {
  const http = { get: jest.fn() };
  (mockedAxios.create as jest.Mock).mockReturnValue(http);
  return { client: new HolidaysClient(), http };
}

describe('HolidaysClient', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the holiday name for a matching date', async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValue({
      data: [{ date: '2026-09-18', localName: 'Fiestas Patrias', name: 'Independence Day' }],
    });

    const name = await client.getHolidayName(new Date('2026-09-18T12:00:00Z'), 'MLC');
    expect(name).toBe('Fiestas Patrias');
  });

  it('returns null for a non-holiday date', async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValue({ data: [{ date: '2026-09-18', localName: 'X', name: 'X' }] });
    expect(await client.getHolidayName(new Date('2026-06-02T12:00:00Z'), 'MLC')).toBeNull();
  });

  it('returns null and never hits the network for an unmapped site', async () => {
    const { client, http } = makeClient();
    const r1 = await client.getHolidayName(new Date('2026-01-01T00:00:00Z'), 'ZZZ');
    const r2 = await client.getHolidayName(new Date('2026-01-02T00:00:00Z'), 'ZZZ');
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(http.get).not.toHaveBeenCalled();
  });

  it('caches per (year, country): one network call for repeated lookups', async () => {
    const { client, http } = makeClient();
    http.get.mockResolvedValue({ data: [{ date: '2026-09-18', localName: 'A', name: 'A' }] });

    await client.getHolidayName(new Date('2026-09-18T00:00:00Z'), 'MLC');
    await client.getHolidayName(new Date('2026-12-25T00:00:00Z'), 'MLC');

    expect(http.get).toHaveBeenCalledTimes(1);
    expect(http.get).toHaveBeenCalledWith('/PublicHolidays/2026/CL');
  });

  it('degrades to null (and caches the empty result) on network failure', async () => {
    const { client, http } = makeClient();
    http.get.mockRejectedValue(new Error('timeout'));

    expect(await client.getHolidayName(new Date('2026-09-18T00:00:00Z'), 'MLC')).toBeNull();
    expect(await client.getHolidayName(new Date('2026-09-19T00:00:00Z'), 'MLC')).toBeNull();
    expect(http.get).toHaveBeenCalledTimes(1);
  });
});
