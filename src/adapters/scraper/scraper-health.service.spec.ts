import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CircuitBreakerOpenError,
  DecodoAccountError,
  FailureSample,
  ScraperAbortError,
  ScraperHealthService,
} from './scraper-health.service';

function makeService(threshold: number, dumpDir: string) {
  const config = {
    scraperFailureThreshold: threshold,
    scraperFailureDumpDir: dumpDir,
  } as any;
  return new ScraperHealthService(config);
}

function sample(url = 'https://x/y'): FailureSample {
  return {
    timestamp: new Date().toISOString(),
    url,
    errorMessage: 'boom',
  };
}

describe('ScraperHealthService', () => {
  let dumpDir: string;

  beforeEach(async () => {
    dumpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'breaker-'));
  });

  afterEach(async () => {
    await fs.rm(dumpDir, { recursive: true, force: true });
  });

  it('does not trip below the threshold', async () => {
    const svc = makeService(3, dumpDir);
    await svc.reportFailure(sample());
    await svc.reportFailure(sample());
    expect(svc.getState().consecutiveFailures).toBe(2);
    expect(svc.getState().tripped).toBe(false);
    expect(() => svc.assertOpen()).not.toThrow();
  });

  it('resets the counter on success', async () => {
    const svc = makeService(3, dumpDir);
    await svc.reportFailure(sample());
    await svc.reportFailure(sample());
    svc.reportSuccess();
    expect(svc.getState().consecutiveFailures).toBe(0);
  });

  it('trips at the threshold, throws, and dumps diagnostics', async () => {
    const svc = makeService(2, dumpDir);
    await svc.reportFailure(sample());

    await expect(svc.reportFailure(sample('https://x/last'), '<html>bad</html>')).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );

    const state = svc.getState();
    expect(state.tripped).toBe(true);
    expect(state.lastDumpDir).not.toBeNull();

    // assertOpen now throws for every later request.
    expect(() => svc.assertOpen()).toThrow(CircuitBreakerOpenError);

    // Diagnostics files exist.
    const files = await fs.readdir(state.lastDumpDir!);
    expect(files).toEqual(expect.arrayContaining(['error.log', 'context.json', 'sample.html']));
    const body = await fs.readFile(path.join(state.lastDumpDir!, 'sample.html'), 'utf8');
    expect(body).toBe('<html>bad</html>');
  });

  it('reset() clears all state', async () => {
    const svc = makeService(2, dumpDir);
    await svc.reportFailure(sample()).catch(() => undefined);
    await svc.reportFailure(sample()).catch(() => undefined);
    svc.reset();
    const state = svc.getState();
    expect(state.tripped).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastDumpDir).toBeNull();
    expect(() => svc.assertOpen()).not.toThrow();
  });

  describe('error class hierarchy', () => {
    it('CircuitBreakerOpenError is a ScraperAbortError', () => {
      expect(new CircuitBreakerOpenError()).toBeInstanceOf(ScraperAbortError);
    });
    it('DecodoAccountError carries its status and is a ScraperAbortError', () => {
      const err = new DecodoAccountError(402, 'out of balance');
      expect(err).toBeInstanceOf(ScraperAbortError);
      expect(err.status).toBe(402);
      expect(err.name).toBe('DecodoAccountError');
    });
  });
});
