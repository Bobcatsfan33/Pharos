import type { Redis } from "ioredis";
import type { CounterStorePort } from "./ports.js";

/**
 * Deadline-bound verdict cache and fixed-window rate-limit counters, backed by Redis so
 * limits hold across API instances (not in process memory).
 *
 * `ioredis` is imported lazily on first use, so a bundle that only runs the embedded
 * backend (the CLI) never loads it. Repeated action shapes could reuse a recent verdict within
 * a short TTL (`get`/`set`); the cascade does not wire that in yet.
 */
export class VerdictCache implements CounterStorePort {
  private client: Promise<Redis> | null = null;
  constructor(private readonly url: string) {}

  private redis(): Promise<Redis> {
    this.client ??= import("ioredis").then(
      ({ Redis }) => new Redis(this.url, { lazyConnect: true, maxRetriesPerRequest: 2 }),
    );
    return this.client;
  }

  async connect(): Promise<void> {
    const redis = await this.redis();
    if (redis.status === "ready" || redis.status === "connecting") return;
    await redis.connect();
  }

  async get(key: string): Promise<string | null> {
    return (await this.redis()).get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await (await this.redis()).set(key, value, "EX", ttlSeconds);
  }

  /**
   * Fixed-window counter for per-principal rate limiting. Returns the current count in
   * the window after incrementing; the first increment sets the window TTL.
   */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    const redis = await this.redis();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttlSeconds);
    return count;
  }

  async ping(): Promise<boolean> {
    try {
      return (await (await this.redis()).ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (!this.client) return;
    await (await this.client).quit();
  }
}
