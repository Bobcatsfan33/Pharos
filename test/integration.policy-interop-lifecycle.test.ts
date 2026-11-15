import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * S9-T1: a policy authored in an EXTERNAL control plane takes the same lifecycle as one
 * written in the constrained grammar. A Cedar JSON document is imported at
 * `POST /policies/compile`, lowered into the canonical `PolicyArtifact`, then dry-run,
 * shadowed, activated and rolled back — because every stage after import sees only the
 * artifact. Run against the real stack; skips only when it is unreachable, which CI fails on.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-interop-keystore-"));
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

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `iop-${randomUUID().slice(0, 8)}`;
let available = true;
let platform: Platform | null = null;
let app: FastifyInstance | null = null;
const auth = { "x-api-key": "", "content-type": "application/json" };
/** Bodyless POSTs must NOT send a JSON content-type: fastify rejects an empty JSON body. */
const authNoBody: Record<string, string> = { "x-api-key": "" };

/** The amount-threshold control, authored as Cedar rather than in the Pharos grammar. */
const CEDAR_DOCUMENT = {
  namespace: "Treasury",
  revision: "2026-11-14",
  title: "Cedar: large vendor transfers need a human",
  policies: [
    {
      id: "cedar-large-transfer",
      effect: "forbid" as const,
      actions: ["payment.transfer"],
      clause: "Treasury control 7 (Cedar)",
      description:
        "A transfer at or above 40,000 is forbidden by the Cedar policy set; open a review instead.",
      conditions: [{ path: "action.payload.amount", operator: "gte" as const, value: 40_000 }],
    },
    // A permit is Pharos's default, so the importer records it as a warning rather than a rule.
    { id: "cedar-default-permit", effect: "permit" as const },
  ],
};

async function pay(amount: number) {
  return app!.inject({
    method: "POST",
    url: "/v1/actions",
    headers: auth,
    payload: {
      tenantId: TENANT,
      action: { type: "payment.transfer", agentId: "treasury", payload: { amount, to: "vendor" } },
      mandateId: "m",
      liability: {
        mandate: null,
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
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Interop" });
    await platform.mandates.create({
      tenantId: TENANT,
      mandateId: "m",
      scope: "pay",
      limits: { maxAmount: 1_000_000 },
      grantor: "cfo",
      expiresAt: null,
    });
    authNoBody["x-api-key"] = auth["x-api-key"] = (
      await platform.apiKeys.create(TENANT, "iop", [
        "actions:write",
        "liability:assert",
        "records:read",
        "policies:read",
        "policies:write",
      ])
    ).plaintext;
  } catch (err) {
    console.warn("[interop] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

describe("S9-T1 — a Cedar policy takes the Pharos lifecycle", () => {
  it("imports → dry-runs → shadow → active (Cedar governs) → rollback", async (ctx) => {
    if (!available) return ctx.skip();

    // Traffic to dry-run against: three over the Cedar threshold, two under it.
    const over = [45_000, 60_000, 41_000];
    const under = [1_000, 39_999];
    for (const a of [...over, ...under]) expect((await pay(a)).statusCode).toBe(201);

    // 1. Import the Cedar document. The same endpoint that compiles grammar text.
    const imported = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/policies/compile`,
      headers: auth,
      payload: { name: "cedar-treasury", source: "cedar", document: CEDAR_DOCUMENT },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const body = imported.json().data;
    expect(body.source).toBe("cedar");
    expect(body.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    // The forbid became a rule; the default permit is reported, not silently dropped.
    expect(body.policy.artifact.rules).toHaveLength(1);
    // The importer namespaces the rule id, so a citation names its source engine.
    expect(body.policy.artifact.rules[0].ruleId).toBe("cedar:cedar-large-transfer");
    expect(body.policy.artifact.rules[0].clause).toBe("Treasury control 7 (Cedar)");
    expect(body.warnings.join(" ")).toMatch(/cedar-default-permit/);
    const policyId = body.policy.id;

    // 2. Dry-run against the recorded traffic: it predicts exactly the three over the line.
    const dry = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/policies/${policyId}/dry-run`,
      headers: auth,
      payload: { window: 1000 },
    });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().data.impact.mix.block).toBe(over.length);

    // 3. Activation requires shadow first (dry-run-before-enforce), same as a compiled policy.
    expect(
      (
        await app!.inject({
          method: "POST",
          url: `/v1/tenants/${TENANT}/policies/${policyId}/activate`,
          headers: authNoBody,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app!.inject({
          method: "POST",
          url: `/v1/tenants/${TENANT}/policies/${policyId}/shadow`,
          headers: authNoBody,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app!.inject({
          method: "POST",
          url: `/v1/tenants/${TENANT}/policies/${policyId}/activate`,
          headers: authNoBody,
        })
      ).statusCode,
    ).toBe(200);

    // 4. Cedar is now the engine of record: the citation a blocked action carries is the
    //    Cedar policy id and its clause.
    const blocked = await pay(50_000);
    expect(blocked.json().data.verdict.decision).toBe("block");
    const citation = blocked
      .json()
      .data.verdict.ruleCitations.find(
        (c: { ruleId: string }) => c.ruleId === "cedar:cedar-large-transfer",
      );
    expect(citation).toBeTruthy();
    expect(citation.clause).toBe("Treasury control 7 (Cedar)");
    // Under the threshold is untouched by the Cedar policy.
    expect((await pay(100)).json().data.verdict.decision).toBe("allow");

    // 5. Rollback restores the prior state, and the chain is undisturbed throughout.
    const rollback = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/policies/cedar-treasury/rollback`,
      headers: authNoBody,
    });
    expect(rollback.statusCode, rollback.body).toBe(200);
    // What rollback proves is that the Cedar rule no longer fires. The same $50k may still
    // reach `escalate` on the statistical tier — that is a different control, and asserting
    // `allow` here would be asserting that Tier 2 is asleep.
    const afterRollback = await pay(50_000);
    expect(afterRollback.json().data.verdict.decision).not.toBe("block");
    expect(
      afterRollback.json().data.verdict.ruleCitations.map((c: { ruleId: string }) => c.ruleId),
    ).not.toContain("cedar:cedar-large-transfer");
    expect((await platform!.integrity.verifyTenant(TENANT)).ok).toBe(true);
  });

  it("refuses a document that is neither an OPA nor a Cedar profile, without creating a draft", async (ctx) => {
    if (!available) return ctx.skip();
    const before = (
      await app!.inject({
        method: "GET",
        url: `/v1/tenants/${TENANT}/policies`,
        headers: auth,
      })
    ).json().data.policies.length;
    const res = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/policies/compile`,
      headers: auth,
      payload: { name: "nonsense", source: "cedar", document: { what: "is this" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("policy_import_failed");
    const after = (
      await app!.inject({
        method: "GET",
        url: `/v1/tenants/${TENANT}/policies`,
        headers: auth,
      })
    ).json().data.policies.length;
    expect(after).toBe(before);
  });
});
