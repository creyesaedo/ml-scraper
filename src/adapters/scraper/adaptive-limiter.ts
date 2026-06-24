/**
 * AIMD (Additive-Increase / Multiplicative-Decrease) concurrency limiter — a
 * closed-loop replacement for a fixed `p-limit` pool.
 *
 * WHY this exists. The Decodo render time per URL is *variable and unbounded*
 * (a clean page ~25 s; a flaky MCO page can ride its internal retry budget for
 * minutes). Little's law says the in-flight count needed to sustain a fixed
 * submission rate is `rate × latency` — so with a fixed pool you must guess the
 * latency, and any guess is wrong: too small and you never reach the plan rate,
 * too large and a latency spike floods Decodo with thousands of concurrent
 * renders whose tail blows out to timeouts.
 *
 * Instead this limiter *discovers* the right concurrency by watching outcomes,
 * exactly like TCP congestion control:
 *   - every successful request, when we were saturated (already using the whole
 *     window), nudges the limit up by `increaseStep` (additive increase);
 *   - every genuine hard failure cuts the limit to `limit × decreaseFactor`
 *     (multiplicative decrease), backing off fast so Decodo's queue can drain.
 *
 * Crucially the drop signal is the *final* outcome of a whole request (after the
 * worker's internal retries), NOT an individual retry. A slow-but-eventually-OK
 * MCO render counts as a success, so a Colombia-heavy batch ramps down only when
 * Decodo is truly saturated, then recovers — it never collapses permanently.
 *
 * The sliding-window rate limiter stays the hard submission ceiling; this
 * limiter only governs how many requests may be *in flight* at once, providing
 * backpressure that lets the effective throughput fall below the plan rate when
 * the backend cannot keep up.
 */

export type RequestOutcome = 'ok' | 'drop';

export interface AdaptiveLimiterOptions {
  /** Lower bound for the window — never throttle below this. */
  minLimit: number;
  /** Upper bound (hard ceiling) for the window. */
  maxLimit: number;
  /** Window size to start from before any feedback. */
  initialLimit: number;
  /** Slots added per saturated success (additive increase). Default 1. */
  increaseStep?: number;
  /** Factor applied to the window on a drop (multiplicative decrease). Default 0.8. */
  decreaseFactor?: number;
}

/** A held slot. Call {@link release} exactly once when the request settles. */
export interface AcquireToken {
  /** Whether the window was (near) full when this slot was granted. Only a
   * success acquired under saturation grows the window — growing while there is
   * spare capacity would be meaningless. */
  saturatedAtAcquire: boolean;
  release: () => void;
}

export class AdaptiveLimiter {
  private limit: number;
  private readonly minLimit: number;
  private readonly maxLimit: number;
  private readonly increaseStep: number;
  private readonly decreaseFactor: number;

  private inFlight = 0;
  /** FIFO of grant callbacks for callers parked waiting for a slot. */
  private readonly queue: Array<(token: AcquireToken) => void> = [];

  // ── observability counters (cheap; read by getStats for logging) ──
  private increases = 0;
  private decreases = 0;

  constructor(opts: AdaptiveLimiterOptions) {
    this.minLimit = Math.max(1, Math.floor(opts.minLimit));
    this.maxLimit = Math.max(this.minLimit, Math.floor(opts.maxLimit));
    this.increaseStep = opts.increaseStep ?? 1;
    this.decreaseFactor = opts.decreaseFactor ?? 0.8;
    this.limit = clamp(opts.initialLimit, this.minLimit, this.maxLimit);
  }

  /** Effective integer window currently in force. */
  private get window(): number {
    return Math.max(this.minLimit, Math.floor(this.limit));
  }

  /**
   * Acquire a slot, waiting (FIFO) until one is free. The returned token's
   * `release()` must be called exactly once when the request settles, and
   * {@link feedback} should be called with the outcome to drive the window.
   */
  acquire(): Promise<AcquireToken> {
    return new Promise<AcquireToken>((resolve) => {
      this.queue.push(resolve);
      this.tryGrant();
    });
  }

  /**
   * Report a settled request's outcome to adjust the window. `ok` grows it by
   * one step *only if* the slot was acquired under saturation; `drop` shrinks it
   * multiplicatively. Safe to call before or after `release()`.
   */
  feedback(outcome: RequestOutcome, saturatedAtAcquire: boolean): void {
    if (outcome === 'drop') {
      const next = Math.max(this.minLimit, Math.floor(this.limit * this.decreaseFactor));
      if (next < this.limit) this.decreases++;
      this.limit = next;
    } else if (saturatedAtAcquire) {
      const next = Math.min(this.maxLimit, this.limit + this.increaseStep);
      if (next > this.limit) this.increases++;
      this.limit = next;
    }
    // A grown window may let parked callers proceed immediately.
    this.tryGrant();
  }

  /** Snapshot for logging/metrics. */
  getStats(): {
    limit: number;
    inFlight: number;
    queued: number;
    increases: number;
    decreases: number;
  } {
    return {
      limit: this.window,
      inFlight: this.inFlight,
      queued: this.queue.length,
      increases: this.increases,
      decreases: this.decreases,
    };
  }

  /**
   * Grant as many parked callers as the current window allows. `inFlight` is
   * incremented synchronously at grant time (not after an awaited microtask) so
   * concurrent drains can never over-grant past the window.
   */
  private tryGrant(): void {
    while (this.queue.length > 0 && this.inFlight < this.window) {
      const resolve = this.queue.shift()!;
      const saturatedAtAcquire = this.inFlight >= this.window - 1;
      this.inFlight++;
      let released = false;
      resolve({
        saturatedAtAcquire,
        release: () => {
          if (released) return;
          released = true;
          this.inFlight--;
          this.tryGrant();
        },
      });
    }
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(value)));
}
