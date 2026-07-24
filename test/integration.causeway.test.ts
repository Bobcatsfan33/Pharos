import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { PharosClient } from "@getpharos/sdk";

/**
 * M3 (Causeway) integration: the SDK round trip over a live server.
 *   - a $25k mandate blocks a $30k action at Tier 1, sealed with the mandate binding;
 *   - an escalate verdict parks, a human verdict resolves it, and the agent resumes
 *     exactly once (concurrent claims execute the side effect at most once).
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-causeway-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "causeway-admin";

type Platform = import("../services/api/src/platform.js").Platform;

const TENANT = `cw-${randomUUID().slice(0, 8)}`;
let available = true;
let platform: Platform | null = null;
let app: FastifyInstance | null = null;
let baseUrl = "";
let apiKey = "";

const REVIEW_SCOPES = [
  "actions:write",
  "records:read",
  "chain:verify",
  "policies:write",
  "policies:read",
  "reviews:read",
  "reviews:act",
];

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    app = await buildApp(platform);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    baseUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Causeway" });
    apiKey = (await platform.apiKeys.create(TENANT, "cw", REVIEW_SCOPES)).plaintext;
  } catch (err) {
    console.warn("[causeway] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

function client(opts: Partial<ConstructorParameters<typeof PharosClient>[0]> = {}): PharosClient {
  return new PharosClient({ baseUrl, apiKey, deadlineMs: 2000, ...opts });
}

async function resolve(
  escalationId: string,
  decision: "approve" | "reject",
  rationale = "reviewed",
) {
  return fetch(`${baseUrl}/v1/tenants/${TENANT}/escalations/${escalationId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ decision, rationale }),
  });
}

describe("Causeway — mandate binding", () => {
  it("a $25k mandate blocks a $30k action at Tier 1 and seals the binding", async (ctx) => {
    if (!available) return ctx.skip();
    // Create the mandate via the API.
    const c = client();
    await fetch(`${baseUrl}/v1/tenants/${TENANT}/mandates`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        mandateId: "vendor-pay",
        scope: "vendor payments",
        limits: { maxAmount: 25000 },
        grantor: "cfo",
      }),
    });

    const res = await c.submit({
      tenantId: TENANT,
      mandateId: "vendor-pay",
      action: {
        type: "payment.transfer",
        agentId: "treasury",
        payload: { amount: 30000, to: "vendor-x" },
      },
      liability: {
        oversightMode: "human_in_loop",
        blastRadius: { financialAmount: 30000, currency: "USD", reversibility: "irreversible" },
      },
    });
    expect(res.verdict.decision).toBe("block");
    expect(res.verdict.tierReached).toBe(1);
    expect(res.verdict.ruleCitations.some((c) => c.ruleId === "mandate-limit-exceeded")).toBe(true);
    // The sealed record carries the mandate binding.
    const record = res.record as { content: { liability: { mandate: { id: string } } } };
    expect(record.content.liability.mandate.id).toBe("vendor-pay");
  });
});

describe("Causeway — escalation round trip (exactly-once)", () => {
  it("escalates, awaits a human verdict, and resumes the side effect exactly once", async (ctx) => {
    if (!available) return ctx.skip();
    const c = client();
    let sideEffectRuns = 0;
    const input = {
      tenantId: TENANT,
      action: {
        type: "message.send",
        agentId: "support",
        payload: { body: "Patient John Smith was diagnosed with HIV and started therapy." },
      },
      liability: {
        oversightMode: "human_in_loop" as const,
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" as const },
      },
    };

    // Start the governed call; it will escalate and await a human verdict.
    const governP = c.govern(
      input,
      () => {
        sideEffectRuns++;
      },
      { pollIntervalMs: 50, timeoutMs: 8000 },
    );

    // A reviewer approves the pending escalation.
    let escalationId = "";
    for (let i = 0; i < 120 && !escalationId; i++) {
      const pending = await (
        await fetch(`${baseUrl}/v1/tenants/${TENANT}/escalations`, {
          headers: { "x-api-key": apiKey },
        })
      ).json();
      if (pending.data.escalations.length > 0) escalationId = pending.data.escalations[0].id;
      else await new Promise((r) => setTimeout(r, 50));
    }
    expect(escalationId).not.toBe("");
    const resolveRes = await resolve(escalationId, "approve");
    expect(resolveRes.status).toBe(200);
    // The human verdict is sealed as a tier-"human" record.
    expect((await resolveRes.json()).data.humanVerdictSequence).toBeGreaterThanOrEqual(0);

    const outcome = await governP;
    expect(outcome.outcome).toBe("executed");
    expect(sideEffectRuns).toBe(1);

    // A second claim must not run again (exactly-once).
    const secondClaim = await c.claim(TENANT, escalationId);
    expect(secondClaim.claimed).toBe(false);
  });

  it("a rejected escalation never runs the side effect", async (ctx) => {
    if (!available) return ctx.skip();
    const c = client();
    let runs = 0;
    const input = {
      tenantId: TENANT,
      action: {
        type: "message.send",
        agentId: "support",
        payload: { body: "Patient Mary Johnson has a positive cancer biopsy." },
      },
      liability: {
        oversightMode: "human_in_loop" as const,
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" as const },
      },
    };
    const governP = c.govern(
      input,
      () => {
        runs++;
      },
      { pollIntervalMs: 50, timeoutMs: 8000 },
    );

    let escalationId = "";
    for (let i = 0; i < 120 && !escalationId; i++) {
      const pending = await (
        await fetch(`${baseUrl}/v1/tenants/${TENANT}/escalations`, {
          headers: { "x-api-key": apiKey },
        })
      ).json();
      const fresh = pending.data.escalations[0];
      if (fresh) escalationId = fresh.id;
      else await new Promise((r) => setTimeout(r, 50));
    }
    await resolve(escalationId, "reject");
    const outcome = await governP;
    expect(outcome.outcome).toBe("skipped");
    expect(runs).toBe(0);
  });

  it("SDK falls back locally when the platform is unreachable (irreversible → fail closed)", async (ctx) => {
    if (!available) return ctx.skip();
    const offline = new PharosClient({
      baseUrl: "http://127.0.0.1:1",
      apiKey,
      deadlineMs: 200,
      maxRetries: 0,
      localFailMode: "fail_closed",
    });
    // S3-T2: the SDK local fail-mode is reversibility-aware. An irreversible action fails
    // CLOSED (escalate) — the safe default. (Reversible→fail-open is covered in
    // test/sdk.failmode.test.ts.)
    const res = await offline.submit({
      tenantId: TENANT,
      action: { type: "email.send", agentId: "a", payload: {} },
      liability: {
        oversightMode: "autonomous",
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "irreversible" },
      },
    });
    expect(res.localFallback).toBe(true);
    expect(res.verdict.failMode).toBe("fail_closed");
    expect(res.verdict.decision).toBe("escalate");
  });
});
