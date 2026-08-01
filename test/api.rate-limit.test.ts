import { describe, it, expect } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../services/api/src/auth.js";
import type { Platform } from "../services/api/src/platform.js";

/**
 * Admission control on the ingest path (threat-model issue #73).
 *
 * Two properties are load-bearing:
 *
 *   1. When the counter store is unreachable the request is REFUSED. Previously the
 *      limiter returned `true` from its catch block, so anyone able to degrade Redis
 *      also removed the ingest rate limit — a denial-of-service amplifier reachable by
 *      an unauthenticated flood against the cache.
 *   2. The limit binds the *tenant*, not just the credential. A tenant holding N API
 *      keys previously had N × the intended budget.
 */

const TENANT = "tenant-a";

interface Captured {
  status: number | null;
  body: unknown;
}

function fakeReply(): { reply: FastifyReply; captured: Captured } {
  const captured: Captured = { status: null, body: null };
  const reply = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    send(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { reply: reply as unknown as FastifyReply, captured };
}

const request = { headers: { "x-api-key": "pk_test_secret" } } as unknown as FastifyRequest;

/**
 * @param incr counter behavior; throw to simulate the cache being unreachable.
 */
function fakePlatform(options: {
  incr: (key: string) => Promise<number>;
  failMode?: "closed" | "open";
  perMin?: number;
  tenantPerMin?: number;
}): Platform {
  return {
    apiKeys: {
      verify: async () => ({
        keyId: "key-1",
        tenantId: TENANT,
        scopes: ["actions:write"],
      }),
    },
    cache: { incr: (key: string) => options.incr(key) },
    config: {
      api: {
        rateLimitPerMin: options.perMin ?? 600,
        rateLimitTenantPerMin: options.tenantPerMin ?? 6000,
        rateLimitFailMode: options.failMode ?? "closed",
      },
    },
  } as unknown as Platform;
}

describe("ingest admission control", () => {
  it("admits a request inside both budgets", async () => {
    const { reply, captured } = fakeReply();
    const platform = fakePlatform({ incr: async () => 1 });

    const principal = await requireAuth(platform, request, reply, "actions:write", TENANT);

    expect(principal).not.toBeNull();
    expect(captured.status).toBeNull();
  });

  it("fails CLOSED with 503 when the counter store is unreachable", async () => {
    const { reply, captured } = fakeReply();
    const platform = fakePlatform({
      incr: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const principal = await requireAuth(platform, request, reply, "actions:write", TENANT);

    expect(principal).toBeNull();
    expect(captured.status).toBe(503);
    // Distinct from 429: the caller is not known to be over budget.
    expect(captured.body).toMatchObject({
      success: false,
      error: { code: "rate_limiter_unavailable" },
    });
  });

  it("admits unmetered only when fail-open is explicitly configured", async () => {
    const { reply, captured } = fakeReply();
    const platform = fakePlatform({
      failMode: "open",
      incr: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const principal = await requireAuth(platform, request, reply, "actions:write", TENANT);

    expect(principal).not.toBeNull();
    expect(captured.status).toBeNull();
  });

  it("refuses with 429 when the per-principal budget is spent", async () => {
    const { reply, captured } = fakeReply();
    const platform = fakePlatform({ perMin: 10, incr: async () => 11 });

    const principal = await requireAuth(platform, request, reply, "actions:write", TENANT);

    expect(principal).toBeNull();
    expect(captured.status).toBe(429);
    expect(captured.body).toMatchObject({ error: { code: "rate_limited" } });
  });

  it("refuses with 429 on the tenant aggregate even when the principal is inside budget", async () => {
    const { reply, captured } = fakeReply();
    // This principal has used 1 of 600; the tenant as a whole has used 5001 of 5000.
    const platform = fakePlatform({
      perMin: 600,
      tenantPerMin: 5000,
      incr: async (key) => (key.startsWith("rl:t:") ? 5001 : 1),
    });

    const principal = await requireAuth(platform, request, reply, "actions:write", TENANT);

    expect(principal).toBeNull();
    expect(captured.status).toBe(429);
  });

  it("counts the principal and the tenant on separate, non-colliding keys", async () => {
    const seen: string[] = [];
    const { reply } = fakeReply();
    const platform = fakePlatform({
      incr: async (key) => {
        seen.push(key);
        return 1;
      },
    });

    await requireAuth(platform, request, reply, "actions:write", TENANT);

    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(2);
    expect(seen).toContain(`rl:p:${TENANT}:key-1`);
    expect(seen).toContain(`rl:t:${TENANT}`);
  });
});
