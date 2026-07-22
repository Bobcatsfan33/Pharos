import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * M6 (Codex) exit criteria: a policy document compiles, dry-runs against historical traffic
 * (impact dashboard), ships in shadow mode, is promoted to active — with the impact
 * prediction matching observed verdicts — and rolls back in well under a minute. Every pack
 * rule carries a citation and renders an examiner-readable explanation.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-codex-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "codex-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `cx-${randomUUID().slice(0, 8)}`;
let available = true;
let platform: Platform | null = null;
let app: FastifyInstance | null = null;
const auth = { "x-api-key": "" };

async function pay(amount: number) {
  return app!.inject({
    method: "POST",
    url: "/v1/actions",
    headers: auth,
    payload: {
      tenantId: TENANT,
      action: { type: "payment.transfer", agentId: "treasury", payload: { amount, to: "vendor" } },
      liability: {
        mandate: {
          id: "m",
          scope: "pay",
          limits: { maxAmount: 1_000_000 },
          grantor: "cfo",
          expiresAt: null,
          version: "1",
        },
        oversightMode: "human_in_loop",
        blastRadius: { financialAmount: amount, currency: "USD", reversibility: "reversible" },
        modelMetadata: null,
      },
    },
  });
}

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    app = await buildApp(platform);
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Codex" });
    auth["x-api-key"] = (
      await platform.apiKeys.create(TENANT, "cx", [
        "actions:write",
        "records:read",
        "policies:read",
        "policies:write",
      ])
    ).plaintext;
  } catch (err) {
    console.warn("[codex] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

describe("Codex — policy lifecycle", () => {
  it("compiles → dry-runs → shadow → active (impact matches) → rollback", async (ctx) => {
    if (!available) return ctx.skip();

    // 1. Historical traffic: 12 payments; six exceed $40k.
    const amounts = [
      10000, 20000, 30000, 45000, 60000, 15000, 55000, 42000, 5000, 80000, 25000, 48000,
    ];
    for (const a of amounts) expect((await pay(a)).statusCode).toBe(201);
    const over40k = amounts.filter((a) => a > 40000).length; // 6

    // 2. Compile a natural-language policy.
    const compile = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/policies/compile`,
      headers: auth,
      payload: {
        name: "acme-payments",
        text: "# Acme payments\nBlock payments when amount over $40000\nRequire human approval for wires",
      },
    });
    expect(compile.statusCode).toBe(201);
    const policyId = compile.json().data.policy.id;
    expect(compile.json().data.policy.artifact.rules.length).toBe(2);

    // 3. Dry-run (impact dashboard) against historical traffic.
    const dryRun = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/policies/${policyId}/dry-run`,
      headers: auth,
      payload: { window: 1000 },
    });
    const predictedBlocks = dryRun.json().data.impact.mix.block;
    expect(predictedBlocks).toBe(over40k); // predicts six blocks

    // 4. Activation requires shadow first (dry-run-before-enforce).
    const earlyActivate = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/policies/${policyId}/activate`,
      headers: auth,
    });
    expect(earlyActivate.statusCode).toBe(409);

    // 5. Shadow → divergence → activate.
    expect(
      (
        await app!.inject({
          method: "POST",
          url: `/v1/tenants/${TENANT}/policies/${policyId}/shadow`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    const divergence = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/policies/${policyId}/divergence`,
      headers: auth,
      payload: { window: 1000 },
    });
    expect(divergence.json().data.diverged).toBeGreaterThan(0);
    expect(
      (
        await app!.inject({
          method: "POST",
          url: `/v1/tenants/${TENANT}/policies/${policyId}/activate`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);

    // 6. Observed verdicts now match the prediction: a >$40k payment blocks with the compiled,
    //    examiner-readable citation.
    const blocked = await pay(45000);
    expect(blocked.json().data.verdict.decision).toBe("block");
    const citation = blocked
      .json()
      .data.verdict.ruleCitations.find((c: { ruleId: string }) => c.ruleId === "acme-payments-r1");
    expect(citation).toBeTruthy();
    expect(citation.description.length).toBeGreaterThan(10); // examiner-readable

    // A sub-threshold payment is not blocked by the custom policy.
    expect((await pay(30000)).json().data.verdict.decision).toBe("allow");

    // 7. Rollback restores prior state in well under a minute, with no chain disruption.
    const t0 = Date.now();
    const rollback = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/policies/acme-payments/rollback`,
      headers: auth,
    });
    expect(rollback.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(60_000);
    // After rollback the $45k payment is no longer blocked by the (now-inactive) custom policy.
    expect((await pay(45000)).json().data.verdict.decision).toBe("allow");

    // Evidence chain remains intact across the lifecycle.
    const chain = await platform!.integrity.verifyTenant(TENANT);
    expect(chain.ok).toBe(true);
  });
});
