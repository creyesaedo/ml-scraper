/**
 * Sliding-window rate limiter for the MercadoLibre official API.
 *
 * ML caps requests at 1500/min per app = 25 req/s; exceeding it returns HTTP 429
 * with an empty body. Every enrichment product fans out to ~3 ML calls
 * (catalog/date + reviews + visits), so a sync's bursts blow past 25/s and get
 * throttled — silently nulling review/visit data. This limiter is the single
 * global pacer in front of `MercadoLibreClient`: callers `await acquire()` before
 * each request, and at most `perSec` starts happen in any rolling 1000 ms window.
 * Default is set BELOW the hard limit (headroom) and tunable via env so the rate
 * can be re-pointed if ML changes the cap.
 */
export class MlRateLimiter {
  private readonly starts: number[] = [];

  constructor(private readonly perSec: number) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.starts.length && now - this.starts[0] >= 1000) this.starts.shift();
      if (this.starts.length < this.perSec) {
        this.starts.push(now);
        return;
      }
      await sleep(1000 - (now - this.starts[0]) + 1);
    }
  }
}

const RETRY_BACKOFF_MAX_MS = 30_000;

/** Exponential backoff (baseMs · 2^attempt, capped), 0-based attempt. */
export function mlBackoffMs(attempt: number, baseMs = 500): number {
  return Math.min(baseMs * 2 ** attempt, RETRY_BACKOFF_MAX_MS);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
