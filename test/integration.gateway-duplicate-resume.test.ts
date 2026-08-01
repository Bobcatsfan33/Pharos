import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { PharosClient } from "@getpharos/sdk";
import { createGatewayApp } from "@pharos/gateway";
import { PostgresHeldRequestStore, heldRequestKeyProviderFromMaster } from "@pharos/storage";

/**
 * Duplicate resume must never double-deliver (S8-T1 AC, issue #38).
 *
 * The AC clause "duplicate resume rejected" was the last one without a test of its own.
 * A held continuation carries a real side effect — the request the agent was blocked
 * from making — so resuming it twice means performing that side effect twice. Three
 * shapes matter, and only the first was covered incidentally by the restart test:
 *
 *   1. sequential — resume a continuation that already delivered;
 *   2. concurrent — two gateway replicas racing recovery for the same escalation;
 *   3. overlapping — a retry arriving while a slow first delivery is still in flight.
 *
 * Exactly-once here rests on two independent gates, and this suite pins both:
 *   - the held-request lease (`acquire` is a conditional UPDATE, `complete` a DELETE), and
 *   - the server-side resume claim (`resumed_at IS NULL`), which is the at-most-once
 *     authorization for the side effect.
 *
 * Note the deliberate boundary: a crash *between* forwarding and completing leaves the
 * row present and the claim consumed, and recovery will forward again on purpose. That
 * ambiguity is bounded by the stable upstream `Idempotency-Key`, and is documented as a
 * protocol limit in docs/LIMITATIONS.md. It is not what "duplicate resume" means here.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-dupres-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "dupres-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `dup-${randomUUID().slice(0, 8)}`;

let available = true;
let platform: Platform | null = null;
let pharosApp: FastifyInstance | null = null;
let targetApp: FastifyInstance | null = null;
let pharosUrl = "";
let targetUrl = "";
let apiKey = "";
let client: PharosClient;
const holdMasterKey = randomBytes(32);

/** Every delivery the upstream actually performed. The side-effect counter. */
let upstreamHits = 0;
/** Set >0 to make the upstream slow, so a retry can arrive mid-delivery. */
let upstreamDelayMs = 0;

/** A gateway "replica": its own app instance over the same Postgres-backed store. */
async function startReplica(): Promise<{ app: FastifyInstance; url: string }> {
  const app = createGatewayApp({
    client,
    tenantId: TENANT,
    agentId: "unmodified-agent",
    target: targetUrl,
    heldRequestStore: new PostgresHeldRequestStore(
      platform!.pool,
      heldRequestKeyProviderFromMaster(holdMasterKey),
      // Long lease: a stale lease is a different scenario (recovery), not duplicate resume.
      { leaseMs: 30_000 },
    ),
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
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const url = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  return { app, url };
}

let replicaA: { app: FastifyInstance; url: string };
let replicaB: { app: FastifyInstance; url: string };

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    pharosApp = await buildApp(platform);
    await pharosApp.listen({ port: 0, host: "127.0.0.1" });
    const pa = pharosApp.server.address();
    pharosUrl = typeof pa === "object" && pa ? `http://127.0.0.1:${pa.port}` : "";

    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "DupResume" });
    apiKey = (
      await platform.apiKeys.create(TENANT, "dup", [
        "actions:write",
        "records:read",
        "reviews:read",
        "reviews:act",
      ])
    ).plaintext;

    targetApp = Fastify();
    targetApp.post("/send", async () => {
      upstreamHits++;
      if (upstreamDelayMs > 0) await new Promise((r) => setTimeout(r, upstreamDelayMs));
      return { sent: true };
    });
    await targetApp.listen({ port: 0, host: "127.0.0.1" });
    const ta = targetApp.server.address();
    targetUrl = typeof ta === "object" && ta ? `http://127.0.0.1:${ta.port}` : "";

    client = new PharosClient({ baseUrl: pharosUrl, apiKey, deadlineMs: 4000 });
    replicaA = await startReplica();
    replicaB = await startReplica();
  } catch (err) {
    console.warn("[dup-resume] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await replicaA?.app.close();
  await replicaB?.app.close();
  await targetApp?.close();
  await pharosApp?.close();
  await platform?.close();
});

/** Send PHI through a replica so the cascade escalates and the body is held. */
async function escalate(url: string): Promise<string> {
  const res = await fetch(`${url}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      body: `Patient ${randomUUID().slice(0, 8)} was diagnosed with HIV and started antiretroviral therapy.`,
    }),
  });
  expect(res.status).toBe(202);
  return (await res.json()).escalationId as string;
}

async function approve(escalationId: string): Promise<void> {
  const res = await fetch(`${pharosUrl}/v1/tenants/${TENANT}/escalations/${escalationId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ decision: "approve", rationale: "cleared for delivery" }),
  });
  expect(res.status).toBe(200);
}

const resume = (url: string, id: string) => fetch(`${url}/__resume/${id}`, { method: "POST" });

describe("duplicate resume is rejected (#38)", () => {
  it("refuses a sequential second resume of a delivered continuation", async (ctx) => {
    if (!available) return ctx.skip();
    const id = await escalate(replicaA.url);
    await approve(id);
    const before = upstreamHits;

    const first = await resume(replicaA.url, id);
    expect(first.status).toBe(200);
    expect(upstreamHits).toBe(before + 1);

    // The successful delivery removed the held row, so there is nothing left to resume.
    const second = await resume(replicaA.url, id);
    expect(second.status).toBe(404);
    expect(upstreamHits).toBe(before + 1);

    // Refusal is by name, not a bare status code.
    expect((await second.json()).error).toMatch(/no held request/i);
  });

  it("refuses a second resume issued at a DIFFERENT replica", async (ctx) => {
    if (!available) return ctx.skip();
    // Durability lives in Postgres, so replica B must refuse what replica A delivered.
    // A per-process guard would pass the test above and fail this one.
    const id = await escalate(replicaA.url);
    await approve(id);
    const before = upstreamHits;

    expect((await resume(replicaA.url, id)).status).toBe(200);
    expect(upstreamHits).toBe(before + 1);

    const second = await resume(replicaB.url, id);
    expect(second.status).toBe(404);
    expect(upstreamHits).toBe(before + 1);
  });

  it("delivers exactly once when two replicas race recovery for the same escalation", async (ctx) => {
    if (!available) return ctx.skip();
    const id = await escalate(replicaA.url);
    await approve(id);
    const before = upstreamHits;

    // The real failure mode: both replicas notice an approved escalation and resume it.
    const [a, b] = await Promise.all([resume(replicaA.url, id), resume(replicaB.url, id)]);
    const statuses = [a.status, b.status].sort();

    // Exactly one delivers; the loser is refused. Whichever wins is not determined.
    expect(upstreamHits).toBe(before + 1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409 || s === 404)).toHaveLength(1);
  });

  it("refuses an overlapping retry while the first delivery is still in flight", async (ctx) => {
    if (!available) return ctx.skip();
    const id = await escalate(replicaA.url);
    await approve(id);
    const before = upstreamHits;

    upstreamDelayMs = 400;
    try {
      const inFlight = resume(replicaA.url, id);
      // Arrive while the lease is held and the upstream has not yet answered.
      await new Promise((r) => setTimeout(r, 120));
      const retry = await resume(replicaB.url, id);

      // 409 busy, distinct from 404: the continuation exists, delivery is in progress.
      expect(retry.status).toBe(409);
      expect((await retry.json()).error).toMatch(/already in progress/i);

      expect((await inFlight).status).toBe(200);
    } finally {
      upstreamDelayMs = 0;
    }
    expect(upstreamHits).toBe(before + 1);
  });

  it("the server-side resume claim is at-most-once, independent of the gateway", async (ctx) => {
    if (!available) return ctx.skip();
    // The second, independent gate. Even a caller bypassing the held-request lease
    // entirely cannot obtain authorization to perform the side effect twice.
    const id = await escalate(replicaA.url);
    await approve(id);

    const first = await platform!.escalations.claimResume(TENANT, id);
    const second = await platform!.escalations.claimResume(TENANT, id);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("never forwards when the escalation was rejected rather than approved", async (ctx) => {
    if (!available) return ctx.skip();
    const id = await escalate(replicaA.url);
    const before = upstreamHits;

    await fetch(`${pharosUrl}/v1/tenants/${TENANT}/escalations/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ decision: "reject", rationale: "PHI must not leave" }),
    });

    const first = await resume(replicaA.url, id);
    const second = await resume(replicaA.url, id);

    expect(first.status).toBe(409);
    expect([404, 409]).toContain(second.status);
    // A rejected continuation is never delivered, however many times it is resumed.
    expect(upstreamHits).toBe(before);
  });
});
