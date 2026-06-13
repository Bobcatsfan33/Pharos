import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { PharosClient } from "@pharos/sdk";
import { createGatewayApp } from "@pharos/gateway";

/**
 * M3 (Causeway) gateway path: an UNMODIFIED agent — one that imports no Pharos SDK and only
 * sends normal HTTP — is governed purely by routing its egress through the gateway. It acts,
 * gets blocked, gets escalated, receives a human verdict, and resumes correctly with
 * exactly-once side effects.
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
    apiKey = (await platform.apiKeys.create(TENANT, "gw", ["actions:write", "records:read", "reviews:read", "reviews:act"])).plaintext;

    // The upstream the agent actually wanted to reach (counts side effects).
    targetApp = Fastify();
    targetApp.post("/send", async () => {
      upstreamHits++;
      return { sent: true };
    });
    await targetApp.listen({ port: 0, host: "127.0.0.1" });
    const ta = targetApp.server.address();
    const targetUrl = typeof ta === "object" && ta ? `http://127.0.0.1:${ta.port}` : "";

    // The gateway: governs egress, forwards to target. The agent points here.
    const client = new PharosClient({ baseUrl: pharosUrl, apiKey, deadlineMs: 2000 });
    gatewayApp = createGatewayApp({
      client,
      tenantId: TENANT,
      agentId: "unmodified-agent",
      target: targetUrl,
      mapAction: (req) => ({
        action: { type: "email.send", payload: req.body as Record<string, unknown> },
        liability: { mandate: null, oversightMode: "human_on_loop", blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" }, modelMetadata: null },
      }),
    });
    await gatewayApp.listen({ port: 0, host: "127.0.0.1" });
    const ga = gatewayApp.server.address();
    gatewayUrl = typeof ga === "object" && ga ? `http://127.0.0.1:${ga.port}` : "";
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
  return fetch(`${gatewayUrl}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("Gateway — zero-code governance of an unmodified agent", () => {
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
    const res = await agentSend({ body: "We guarantee a 20% return with no risk — guaranteed profits!" });
    expect(res.status).toBe(403);
    expect(upstreamHits).toBe(before); // never forwarded
  });

  it("holds an escalation, resumes after a human verdict, forwards exactly once", async (ctx) => {
    if (!available) return ctx.skip();
    const before = upstreamHits;
    const res = await agentSend({ body: "Patient John Smith was diagnosed with HIV and started antiretroviral therapy." });
    expect(res.status).toBe(202);
    const escalationId = (await res.json()).escalationId as string;
    expect(escalationId).toBeTruthy();
    expect(upstreamHits).toBe(before); // not forwarded yet

    // Reviewer approves via Pharos.
    await fetch(`${pharosUrl}/v1/tenants/${TENANT}/escalations/${escalationId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ decision: "approve", rationale: "reviewed PHI exposure, cleared" }),
    });

    // Agent (or operator) resumes via the gateway — forwarded exactly once.
    const resume1 = await fetch(`${gatewayUrl}/__resume/${escalationId}`, { method: "POST" });
    expect(resume1.status).toBe(200);
    expect(upstreamHits).toBe(before + 1);

    // A second resume must not forward again.
    const resume2 = await fetch(`${gatewayUrl}/__resume/${escalationId}`, { method: "POST" });
    expect([404, 409]).toContain(resume2.status);
    expect(upstreamHits).toBe(before + 1);
  });
});
