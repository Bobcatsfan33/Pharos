import { Redis } from "ioredis";

/**
 * Deadline-bound verdict cache.
 *
 * Repeated action shapes can reuse a recent verdict within a short TTL to stay inside
 * the latency budget. Sprint 0 provides the cache primitive; Sprint 2 (Lantern) wires
 * semantic/plan-level cache keys into the cascade.
 */
export class VerdictCache {
  private readonly redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async connect(): Promise<void> {
    if (this.redis.status === "ready" || this.redis.status === "connecting") return;
    await this.redis.connect();
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }

  /**
   * Fixed-window counter for per-principal rate limiting. Returns the current count in
   * the window after incrementing; the first increment sets the window TTL. Backed by
   * Redis so limits hold across API instances (not in process memory).
   */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, ttlSeconds);
    return count;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
