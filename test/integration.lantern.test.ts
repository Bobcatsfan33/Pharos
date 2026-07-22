import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * M2 (Lantern) integration: the real cascade served over the API, the reproducibility
 * (replay) endpoint, and chaos fail-mode semantics (judge fault, Postgres down).
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-lantern-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "lantern-admin";

type Platform = import("../services/api/src/platform.js").Platform;

const TENANT = `ln-${randomUUID().slice(0, 8)}`;
let available = true;
let platform: Platform | null = null;
let key = "";

async function submit(app: import("fastify").FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/v1/actions",
    headers: { "x-api-key": key },
    payload: { tenantId: TENANT, ...payload },
  });
}

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    platform = await buildPlatform();
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Lantern" });
    const created = await platform.apiKeys.create(TENANT, "ln", [
      "actions:write",
      "records:read",
      "chain:verify",
    ]);
    key = created.plaintext;
  } catch (err) {
    console.warn("[lantern] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await platform?.close();
});

describe("Lantern — served cascade over the API", () => {
  it("blocks FINRA promissory language at Tier 3 and seals the judge version", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    const { buildApp } = await import("../services/api/src/app.js");
    const app = await buildApp(platform);
    const res = await submit(app, {
      action: {
        type: "email.send",
        agentId: "sales",
        payload: { body: "We guarantee a 20% return with no risk — guaranteed profits!" },
      },
      liability: {
        mandate: null,
        oversightMode: "autonomous",
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
        modelMetadata: null,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.verdict.decision).toBe("block");
    expect(body.data.verdict.tierReached).toBe(3);
    expect(body.data.verdict.judgeVersion).toMatch(/^finra-promissory@/);
    expect(body.data.record.content.verdict.judgeVersion).toMatch(/^finra-promissory@/);
    await app.close();
  });

  it("replays a sealed verdict bit-identically (latency excluded)", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    const { buildApp } = await import("../services/api/src/app.js");
    const app = await buildApp(platform);
    // Submit ten varied actions, then replay each and require identical fingerprints.
    const payloads = [
      { type: "email.send", body: "Thanks, your statement is attached." },
      { type: "email.send", body: "We guarantee guaranteed risk free returns, sure profit!" },
      { type: "message.send", body: "Patient Mary Johnson has a positive cancer biopsy." },
      { type: "payment.transfer", body: "Wire 9800 to the vendor now.", amount: 9800 },
      { type: "crm.update", body: "update lead 42" },
    ];
    const seqs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const p = payloads[i % payloads.length]!;
      const res = await submit(app, {
        action: { type: p.type, agentId: "a", payload: { body: p.body, amount: p.amount } },
        liability: {
          mandate: null,
          oversightMode: "autonomous",
          blastRadius: {
            financialAmount: p.amount ?? 0,
            currency: "USD",
            reversibility: "reversible",
          },
          modelMetadata: null,
        },
      });
      seqs.push(res.json().data.record.content.sequence);
    }
    for (const seq of seqs) {
      const replay = await app.inject({
        method: "GET",
        url: `/v1/replay/${TENANT}/${seq}`,
        headers: { "x-api-key": key },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().data.identical).toBe(true);
    }
    await app.close();
  });

  it("lists the served judge models", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    const { buildApp } = await import("../services/api/src/app.js");
    const app = await buildApp(platform);
    const res = await app.inject({ method: "GET", url: "/v1/judges" });
    const ids = res.json().data.models.map((m: { packId: string }) => m.packId);
    expect(ids).toContain("finra-promissory");
    expect(ids).toContain("phi-in-context");
    expect(ids).toContain("funds-movement-intent");
    await app.close();
  });

  it("CHAOS: a judge fault fails closed (irreversible) and seals an explaining record", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    const { buildApp } = await import("../services/api/src/app.js");
    const { VerdictCascade, DEFAULT_PACK_BINDINGS } =
      await import("../packages/cascade/src/index.js");
    const { VerdictEngine } = await import("../packages/core/src/index.js");
    // Swap in a cascade whose Tier-3 judge always faults.
    platform.cascade = new VerdictCascade({
      engine: new VerdictEngine({ deadlineMs: 800 }),
      registry: platform.registry,
      deadlineMs: 800,
      packs: DEFAULT_PACK_BINDINGS,
      faults: { judgeThrows: true },
    });
    const app = await buildApp(platform);

    const irreversible = await submit(app, {
      action: { type: "payment.transfer", agentId: "a", payload: { amount: 500 } },
      liability: {
        mandate: null,
        oversightMode: "human_in_loop",
        blastRadius: { financialAmount: 500, currency: "USD", reversibility: "irreversible" },
        modelMetadata: null,
      },
    });
    expect(irreversible.statusCode).toBe(201);
    const ir = irreversible.json().data;
    expect(ir.verdict.decision).toBe("escalate");
    expect(ir.verdict.failMode).toBe("fail_closed");
    expect(ir.record.content.verdict.failMode).toBe("fail_closed"); // sealed evidence explains it

    const reversible = await submit(app, {
      action: { type: "email.send", agentId: "a", payload: { body: "hi" } },
      liability: {
        mandate: null,
        oversightMode: "autonomous",
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
        modelMetadata: null,
      },
    });
    expect(reversible.json().data.verdict.failMode).toBe("fail_open");
    await app.close();
  });

  it("CHAOS: Postgres down mid-verdict records nothing (verdict + evidence are atomic)", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    const { buildApp } = await import("../services/api/src/app.js");
    const { buildPlatform } = await import("../services/api/src/platform.js");
    // Fresh platform we can safely break by ending its pool.
    const victim = await buildPlatform();
    await victim.tenants.createTenant({ tenantId: TENANT + "-x", displayName: "x" });
    const vkey = (await victim.apiKeys.create(TENANT + "-x", "x", ["actions:write"])).plaintext;
    const app = await buildApp(victim);
    await victim.pool.end(); // kill Postgres connectivity mid-flight

    const res = await app.inject({
      method: "POST",
      url: "/v1/actions",
      headers: { "x-api-key": vkey },
      payload: {
        tenantId: TENANT + "-x",
        action: { type: "email.send", agentId: "a", payload: {} },
        liability: {
          mandate: null,
          oversightMode: "autonomous",
          blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
          modelMetadata: null,
        },
      },
    });
    // No partial record: the request fails rather than returning an unsealed verdict.
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    await app.close();
  });
});
