import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { PharosClient } from "@getpharos/sdk";
import { createGatewayApp } from "@pharos/gateway";
import {
  PostgresHeldRequestStore,
  heldRequestKeyProviderFromMaster,
  heldRequestKeyringFromMasters,
} from "@pharos/storage";

/**
 * M3 (Causeway) gateway path: an UNMODIFIED agent — one that imports no Pharos SDK and only
 * sends normal HTTP — is governed purely by routing its egress through the gateway. It acts,
 * gets blocked, gets escalated, receives a human verdict, and resumes correctly with
 * restart-safe held-request delivery with an upstream idempotency key.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-gw-keystore-"));
process.env.PHAROS_ENV = "local";
process.env.PHAROS_PG_URL ??= "postgres://pharos:pharos_local_dev@localhost:5433/pharos";
process.env.PHAROS_REDIS_URL ??= "redis://localhost:6380";
process.env.PHAROS_S3_ENDPOINT ??= "http://localhost:9010";
process.env.PHAROS_S3_REGION ??= "us-east-1";
process.env.PHAROS_S3_BUCKET ??= "pharos-evidence";
process.env.PHAROS_S3_ACCESS_KEY ??= "pharos";
process.env.PHAROS_S3_SECRET_KEY ??= "pharos_local_dev";
process.env.PHAROS_S3_FORCE_PATH_STYLE ??= "true";
process.env.PHAROS_KMS_PROVIDER = "local-kms";
process.env.PHAROS_KMS_KEYSTORE_DIR = keystoreDir;
process.env.PHAROS_ADMIN_TOKEN = "gw-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `gw-${randomUUID().slice(0, 8)}`;

let available = true;
let platform: Platform | null = null;
let pharosApp: FastifyInstance | null = null;
let targetApp: FastifyInstance | null = null; // the "real" upstream the agent calls
let gatewayApp: FastifyInstance | null = null;
let gatewayUrl = "";
let pharosUrl = "";
let apiKey = "";
let upstreamHits = 0;
let upstreamIdempotencyKey: string | undefined;
let targetUrl = "";
let gatewayClient: PharosClient;
const gatewayHoldMasterKey = randomBytes(32);

async function startGateway(): Promise<void> {
  if (!platform) throw new Error("platform is not initialized");
  gatewayApp = createGatewayApp({
    client: gatewayClient,
    tenantId: TENANT,
    agentId: "unmodified-agent",
    target: targetUrl,
    heldRequestStore: new PostgresHeldRequestStore(
      platform.pool,
      heldRequestKeyProviderFromMaster(gatewayHoldMasterKey),
      { leaseMs: 500 },
    ),
    readinessCheck: async () => void (await platform!.pool.query("SELECT 1")),
    mapAction: (req) => ({
      action: { type: "message.send", payload: req.body as Record<string, unknown> },
      liability: {
        mandate: null,
        oversightMode: "human_on_loop",
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
        modelMetadata: null,
      },
    }),
  });
  await gatewayApp.listen({ port: 0, host: "127.0.0.1" });
  const address = gatewayApp.server.address();
  gatewayUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
}

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    pharosApp = await buildApp(platform);
    await pharosApp.listen({ port: 0, host: "127.0.0.1" });
    const pa = pharosApp.server.address();
    pharosUrl = typeof pa === "object" && pa ? `http://127.0.0.1:${pa.port}` : "";
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Gateway" });
    apiKey = (
      await platform.apiKeys.create(TENANT, "gw", [
        "actions:write",
        "records:read",
        "reviews:read",
        "reviews:act",
      ])
    ).plaintext;

    // The upstream the agent actually wanted to reach (counts side effects).
    targetApp = Fastify();
    targetApp.post("/send", async (request) => {
      upstreamHits++;
      upstreamIdempotencyKey = request.headers["idempotency-key"];
      return { sent: true };
    });
    await targetApp.listen({ port: 0, host: "127.0.0.1" });
    const ta = targetApp.server.address();
    targetUrl = typeof ta === "object" && ta ? `http://127.0.0.1:${ta.port}` : "";

    // The gateway: governs egress, forwards to target. The agent points here.
    gatewayClient = new PharosClient({ baseUrl: pharosUrl, apiKey, deadlineMs: 2000 });
    await startGateway();
  } catch (err) {
    console.warn("[gateway] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await gatewayApp?.close();
  await targetApp?.close();
  await pharosApp?.close();
  await platform?.close();
});

// The "unmodified agent": plain HTTP to the gateway, zero Pharos code.
async function agentSend(body: unknown) {
  return fetch(`${gatewayUrl}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Gateway — zero-code governance of an unmodified agent", () => {
  it("exposes reserved liveness and dependency-readiness endpoints", async (ctx) => {
    if (!available) return ctx.skip();
    const health = await fetch(`${gatewayUrl}/__pharos/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const ready = await fetch(`${gatewayUrl}/__pharos/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });
  });

  it("leases held requests exclusively and recovers an abandoned lease", async (ctx) => {
    if (!available) return ctx.skip();
    const escalationId = randomUUID();
    const store = new PostgresHeldRequestStore(
      platform!.pool,
      heldRequestKeyProviderFromMaster(gatewayHoldMasterKey),
      { leaseMs: 20 },
    );
    await store.save(TENANT, escalationId, {
      method: "POST",
      path: "/lease-test",
      body: { secret: "encrypted" },
      headers: {},
    });

    const first = await store.acquire(TENANT, escalationId);
    expect(first.status).toBe("acquired");
    expect(await store.acquire(TENANT, escalationId)).toEqual({ status: "busy" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const recovered = await store.acquire(TENANT, escalationId);
    expect(recovered.status).toBe("acquired");
    if (first.status !== "acquired" || recovered.status !== "acquired") {
      throw new Error("test setup did not acquire held-request leases");
    }
    expect(recovered.leaseToken).not.toBe(first.leaseToken);
    expect(await store.complete(TENANT, escalationId, first.leaseToken)).toBe(false);
    expect(await store.release(TENANT, escalationId, recovered.leaseToken, "retry")).toBe(true);

    const final = await store.acquire(TENANT, escalationId);
    if (final.status !== "acquired") throw new Error("released lease was not reacquired");
    expect(await store.complete(TENANT, escalationId, final.leaseToken)).toBe(true);
  });

  it("rejects oversized held requests before persistence", async (ctx) => {
    if (!available) return ctx.skip();
    const store = new PostgresHeldRequestStore(
      platform!.pool,
      heldRequestKeyProviderFromMaster(gatewayHoldMasterKey),
      { maxBytes: 64 },
    );
    await expect(
      store.save(TENANT, randomUUID(), {
        method: "POST",
        path: "/size-test",
        body: { content: "x".repeat(128) },
        headers: {},
      }),
    ).rejects.toThrow(/limit is 64 bytes/);
  });

  it("re-encrypts pending requests online under a new active key", async (ctx) => {
    if (!available) return ctx.skip();
    const escalationId = randomUUID();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const oldStore = new PostgresHeldRequestStore(
      platform!.pool,
      heldRequestKeyringFromMasters("2026-q3", { "2026-q3": oldKey }),
    );
    await oldStore.save(TENANT, escalationId, {
      method: "POST",
      path: "/rotation-test",
      body: { retained: true },
      headers: {},
    });
    expect(await oldStore.keyUsage(TENANT)).toContainEqual({ keyId: "2026-q3", count: 1 });

    const rotatingStore = new PostgresHeldRequestStore(
      platform!.pool,
      heldRequestKeyringFromMasters("2026-q4", {
        "2026-q3": oldKey,
        "2026-q4": newKey,
      }),
    );
    expect(await rotatingStore.reencryptPending(TENANT)).toBe(1);
    expect(await rotatingStore.keyUsage(TENANT)).toContainEqual({ keyId: "2026-q4", count: 1 });

    const newOnlyStore = new PostgresHeldRequestStore(
      platform!.pool,
      heldRequestKeyringFromMasters("2026-q4", { "2026-q4": newKey }),
    );
    const acquired = await newOnlyStore.acquire(TENANT, escalationId);
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("rotated request was not acquired");
    expect(acquired.request.body).toEqual({ retained: true });
    expect(await newOnlyStore.complete(TENANT, escalationId, acquired.leaseToken)).toBe(true);
  });

  it("forwards a benign action to the upstream", async (ctx) => {
    if (!available) return ctx.skip();
    const before = upstreamHits;
    const res = await agentSend({ body: "Thanks for reaching out, your statement is attached." });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-pharos-decision")).toBe("allow");
    expect(upstreamHits).toBe(before + 1);
  });

  it("blocks a FINRA-promissory action before it reaches the upstream", async (ctx) => {
    if (!available) return ctx.skip();
    const before = upstreamHits;
    const res = await agentSend({
      body: "We guarantee a 20% return with no risk — guaranteed profits!",
    });
    expect(res.status).toBe(403);
    expect(upstreamHits).toBe(before); // never forwarded
  });

  it("holds an escalation across restart and resumes with a stable idempotency key", async (ctx) => {
    if (!available) return ctx.skip();
    const before = upstreamHits;
    const res = await agentSend({
      body: "Patient John Smith was diagnosed with HIV and started antiretroviral therapy.",
    });
    expect(res.status).toBe(202);
    const escalationId = (await res.json()).escalationId as string;
    expect(escalationId).toBeTruthy();
    expect(upstreamHits).toBe(before); // not forwarded yet

    const raw = await platform!.pool.query<{ ciphertext: Buffer }>(
      `SELECT ciphertext FROM gateway_held_requests
       WHERE tenant_id = $1 AND escalation_id = $2`,
      [TENANT, escalationId],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]!.ciphertext.toString("utf8")).not.toContain("Patient John Smith");

    const otherTenantStore = new PostgresHeldRequestStore(
      platform!.pool,
      heldRequestKeyProviderFromMaster(gatewayHoldMasterKey),
    );
    expect(await otherTenantStore.acquire(`${TENANT}-other`, escalationId)).toEqual({
      status: "missing",
    });

    // The held body is in Postgres, not process memory. Replace the gateway process
    // before review and prove a fresh instance can still deliver it.
    await gatewayApp?.close();
    gatewayApp = null;
    await startGateway();

    // Reviewer approves via Pharos.
    await fetch(`${pharosUrl}/v1/tenants/${TENANT}/escalations/${escalationId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ decision: "approve", rationale: "reviewed PHI exposure, cleared" }),
    });

    // Agent (or operator) resumes via the gateway; this successful delivery is removed.
    const resume1 = await fetch(`${gatewayUrl}/__resume/${escalationId}`, { method: "POST" });
    expect(resume1.status).toBe(200);
    expect(upstreamHits).toBe(before + 1);
    expect(upstreamIdempotencyKey).toBe(`pharos-escalation-${escalationId}`);

    // A second resume must not forward again.
    const resume2 = await fetch(`${gatewayUrl}/__resume/${escalationId}`, { method: "POST" });
    expect([404, 409]).toContain(resume2.status);
    expect(upstreamHits).toBe(before + 1);
  });
});
