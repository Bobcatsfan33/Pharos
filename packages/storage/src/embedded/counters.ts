import type { CounterStorePort } from "../ports.js";

/**
 * In-process fixed-window counters. Correct for one API process; limits do NOT hold across
 * instances (the backend posture says `multiInstanceRateLimits: false`). Redis is the
 * production counter store.
 */
export class InMemoryCounterStore implements CounterStorePort {
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async connect(): Promise<void> {}

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const t = this.now();
    const cur = this.windows.get(key);
    if (!cur || cur.expiresAt <= t) {
      this.windows.set(key, { count: 1, expiresAt: t + ttlSeconds * 1000 });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.windows.clear();
  }
}
