import { AdaptiveLimiter, AcquireToken } from './adaptive-limiter';

/** Resolves on the next macrotask so queued grants can settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('AdaptiveLimiter', () => {
  describe('gating', () => {
    it('grants up to the window and queues the rest in FIFO order', async () => {
      const lim = new AdaptiveLimiter({ minLimit: 1, maxLimit: 5, initialLimit: 2 });

      const t1 = await lim.acquire();
      const t2 = await lim.acquire();
      expect(lim.getStats().inFlight).toBe(2);

      // Third acquire must park — the window is full.
      let t3: AcquireToken | undefined;
      lim.acquire().then((t) => (t3 = t));
      await tick();
      expect(t3).toBeUndefined();
      expect(lim.getStats().queued).toBe(1);

      // Releasing one frees the parked caller.
      t1.release();
      await tick();
      expect(t3).toBeDefined();
      expect(lim.getStats().inFlight).toBe(2);

      t2.release();
      t3!.release();
      expect(lim.getStats().inFlight).toBe(0);
    });

    it('never over-grants when many release at once', async () => {
      const lim = new AdaptiveLimiter({ minLimit: 1, maxLimit: 3, initialLimit: 3 });
      const tokens = await Promise.all([lim.acquire(), lim.acquire(), lim.acquire()]);

      const parked: AcquireToken[] = [];
      for (let i = 0; i < 5; i++) lim.acquire().then((t) => parked.push(t));
      await tick();
      expect(lim.getStats().inFlight).toBe(3);
      expect(lim.getStats().queued).toBe(5);

      // Release all three synchronously; the window must stay capped at 3.
      tokens.forEach((t) => t.release());
      await tick();
      expect(lim.getStats().inFlight).toBe(3);
      expect(lim.getStats().queued).toBe(2);
    });

    it('release is idempotent', async () => {
      const lim = new AdaptiveLimiter({ minLimit: 1, maxLimit: 2, initialLimit: 2 });
      const t = await lim.acquire();
      t.release();
      t.release();
      expect(lim.getStats().inFlight).toBe(0);
    });
  });

  describe('AIMD adjustment', () => {
    it('additively increases only on a success acquired under saturation', async () => {
      const lim = new AdaptiveLimiter({ minLimit: 1, maxLimit: 10, initialLimit: 2, increaseStep: 1 });

      // Two acquires fill the window of 2 → the 2nd was saturated.
      const t1 = await lim.acquire();
      const t2 = await lim.acquire();
      expect(t2.saturatedAtAcquire).toBe(true);

      lim.feedback('ok', t2.saturatedAtAcquire); // saturated success → +1
      expect(lim.getStats().limit).toBe(3);

      lim.feedback('ok', t1.saturatedAtAcquire); // t1 was NOT saturated → no growth
      expect(lim.getStats().limit).toBe(3);

      t1.release();
      t2.release();
    });

    it('multiplicatively decreases on a drop and respects the floor', async () => {
      const lim = new AdaptiveLimiter({
        minLimit: 2,
        maxLimit: 100,
        initialLimit: 20,
        decreaseFactor: 0.5,
      });
      lim.feedback('drop', false);
      expect(lim.getStats().limit).toBe(10);
      lim.feedback('drop', false);
      expect(lim.getStats().limit).toBe(5);
      lim.feedback('drop', false);
      expect(lim.getStats().limit).toBe(2); // floor 2 (floor(2.5) clamped to min)
      lim.feedback('drop', false);
      expect(lim.getStats().limit).toBe(2); // stays at the floor
    });

    it('never grows past the ceiling', async () => {
      const lim = new AdaptiveLimiter({ minLimit: 1, maxLimit: 3, initialLimit: 3, increaseStep: 5 });
      lim.feedback('ok', true);
      expect(lim.getStats().limit).toBe(3);
    });

    it('a grown window immediately releases parked callers', async () => {
      const lim = new AdaptiveLimiter({ minLimit: 1, maxLimit: 5, initialLimit: 1, increaseStep: 1 });
      const t1 = await lim.acquire();

      let t2: AcquireToken | undefined;
      lim.acquire().then((t) => (t2 = t));
      await tick();
      expect(t2).toBeUndefined(); // window of 1 is full

      // Growing the window to 2 should let the parked caller in without a release.
      lim.feedback('ok', true);
      await tick();
      expect(t2).toBeDefined();
      expect(lim.getStats().inFlight).toBe(2);

      t1.release();
      t2!.release();
    });
  });

  describe('fixed-window mode (no-op feedback)', () => {
    it('keeps a constant window when increaseStep=0 and decreaseFactor=1', () => {
      const lim = new AdaptiveLimiter({
        minLimit: 8,
        maxLimit: 8,
        initialLimit: 8,
        increaseStep: 0,
        decreaseFactor: 1,
      });
      lim.feedback('ok', true);
      lim.feedback('drop', true);
      expect(lim.getStats().limit).toBe(8);
    });
  });
});
