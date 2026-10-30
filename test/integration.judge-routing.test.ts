import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { STRUCTURAL_JUDGE_VERSION } from "@pharos/judge";

/**
 * D1 over the served API against the real compose stack: routing and per-judge timings are
 * sealed into the record exactly as the cascade produced them, the structural judge's decisions
 * reach the verdict, and the chain still verifies. Skips only when the stack is unreachable —
 * CI provisions it and fails on any skip.
 */
process.env.PHAROS_KMS_KEYSTORE_DIR = mkdtempSync(join(tmpdir(), "pharos-d1-keys-"));
process.env.PHAROS_ENV ??= "local";
process.env.PHAROS_PG_URL ??= "postgres://pharos:pharos_local_dev@localhost:5433/pharos";
process.env.PHAROS_REDIS_URL ??= "redis://localhost:6380";
process.env.PHAROS_S3_ENDPOINT ??= "http://localhost:9010";
process.env.PHAROS_S3_REGION ??= "us-east-1";
process.env.PHAROS_S3_BUCKET ??= "pharos-evidence";
process.env.PHAROS_S3_ACCESS_KEY ??= "pharos";
process.env.PHAROS_S3_SECRET_KEY ??= "pharos_local_dev";
process.env.PHAROS_S3_FORCE_PATH_STYLE ??= "true";
process.env.PHAROS_KMS_PROVIDER ??= "local-kms";
process.env.PHAROS_ADMIN_TOKEN ??= "local-admin-please-change";

type Platform = import("../services/api/src/platform.js").Platform;
let platform: Platform | null = null;
let app: FastifyInstance | null = null;
let available = false;
let apiKey = "";
const tenantId = `d1-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    app = await buildApp(platform);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: {
        "x-pharos-admin": process.env.PHAROS_ADMIN_TOKEN!,
        "content-type": "application/json",
      },
      payload: { tenantId, displayName: "D1" },
    });
    apiKey = res.json().data.adminKey.plaintext;
    available = true;
  } catch (err) {
    console.warn("[d1-routing] infrastructure unavailable, skipping:", (err as Error).message);
  }
});
afterAll(async () => {
  await app?.close();
  await platform?.close();
});

const submit = (
  type: string,
  payload: Record<string, unknown>,
  liability: Record<string, unknown> = {},
) =>
  app!.inject({
    method: "POST",
    url: "/v1/actions",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    payload: {
      tenantId,
      action: { type, agentId: "d1-agent", payload },
      liability: {
        mandate: null,
        oversightMode: "human_on_loop",
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
        modelMetadata: null,
        ...liability,
      },
    },
  });

describe("D1 — judge panel over the served API", () => {
  it("routes: a crm.update runs no content model, and the sealed record says so", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await submit("crm.update", {
      record: "lead-42",
      body: "We guarantee a 20% return",
    });
    expect(res.statusCode, res.body).toBe(201);
    const { verdict, record } = res.json().data;
    expect(verdict.decision).toBe("allow");
    expect(verdict.tierReached).toBe(3);
    const keys = Object.keys(record.content.verdict.latency.perTier).sort();
    expect(keys).toEqual(["1", "2", "3", "3/structural"]);
    expect(record.content.verdict.latency.perTier["3"]).toBeLessThan(20);
  });

  it("routes: a promissory email runs the communications models and is blocked with the model version sealed", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await submit("email.send", {
      body: "We guarantee a 20% return with no risk, guaranteed profits!",
    });
    expect(res.statusCode, res.body).toBe(201);
    const { verdict, record } = res.json().data;
    expect(verdict.decision).toBe("block");
    const keys = Object.keys(record.content.verdict.latency.perTier).sort();
    expect(keys).toEqual(["1", "2", "3", "3/finra-promissory", "3/phi-in-context", "3/structural"]);
    expect(verdict.judgeVersion).toMatch(/^finra-promissory@/);
    // Tier total ≤ sum of its judges + scheduling slack — the panel ran them together, not in series.
    const sum = keys
      .filter((k) => k.startsWith("3/"))
      .reduce((s, k) => s + record.content.verdict.latency.perTier[k], 0);
    expect(record.content.verdict.latency.perTier["3"]).toBeLessThanOrEqual(sum + 5);
  });

  it("structural: a declared blast radius that contradicts the payload escalates with the structural citation", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await submit(
      "crm.update",
      { record: "x", amount: 500, currency: "EUR" },
      { blastRadius: { financialAmount: 0, currency: "USD", reversibility: "irreversible" } },
    );
    expect(res.statusCode, res.body).toBe(201);
    const { verdict } = res.json().data;
    expect(verdict.decision).toBe("escalate");
    expect(verdict.ruleCitations.map((c: { ruleId: string }) => c.ruleId)).toContain(
      "structural-blast-radius",
    );
    expect(verdict.judgeVersion).toBe(STRUCTURAL_JUDGE_VERSION);
  });

  it("the chain with per-judge timings verifies genesis to head", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await app!.inject({
      method: "GET",
      url: `/v1/chain/${tenantId}/verify`,
      headers: { "x-api-key": apiKey },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.ok).toBe(true);
    expect(res.json().data.recordsChecked).toBe(3);
  });
});
