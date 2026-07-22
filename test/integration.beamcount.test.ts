import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * M7 (Beam Count) exit criteria:
 *   - verified accuracy computes from ≥1,000 real sampled audits with the confidence interval
 *     displayed (the modeled placeholder is gone);
 *   - the readiness gate blocks an external release (the underwriter feed) for a tenant
 *     failing mandate coverage, and the exception workflow unblocks it.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-bc-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "bc-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `bc-${randomUUID().slice(0, 8)}`;
let available = true;
let platform: Platform | null = null;
let app: FastifyInstance | null = null;
const auth = { "x-api-key": "" };

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    app = await buildApp(platform);
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "BeamCount" });
    auth["x-api-key"] = (
      await platform.apiKeys.create(TENANT, "bc", [
        "actions:write",
        "records:read",
        "reviews:act",
        "reviews:read",
        "audit:read",
        "tenants:manage",
      ])
    ).plaintext;
  } catch (err) {
    console.warn("[beamcount] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

describe("Beam Count — assurance, readiness gate, underwriter feed", () => {
  it("computes verified accuracy from >=1000 audits with a confidence interval", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    // Seed a real audit corpus: 1,050 sampled verdicts across packs, 96% upheld by reviewers.
    const candidates = Array.from({ length: 1050 }, (_, i) => ({
      recordSequence: i,
      pack: ["finra", "hipaa", "core"][i % 3]!,
      decision: "allow",
    }));
    await platform.assurance.sample(TENANT, candidates);
    const pending = await platform.assurance.listPending(TENANT, 2000);
    expect(pending.length).toBeGreaterThanOrEqual(1000);
    for (let i = 0; i < pending.length; i++) {
      await platform.assurance.recordAudit(TENANT, pending[i]!.id, i % 25 !== 0, "auditor"); // 96% upheld
    }

    const res = await app!.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/assurance`,
      headers: auth,
    });
    const data = res.json().data;
    expect(data.samples).toBeGreaterThanOrEqual(1000);
    // Measured Wilson interval, not a modeled constant.
    expect(data.verifiedAccuracy.n).toBeGreaterThanOrEqual(1000);
    expect(data.verifiedAccuracy.lower).toBeGreaterThan(0.93);
    expect(data.verifiedAccuracy.lower).toBeLessThan(data.verifiedAccuracy.point);
    expect(data.verifiedAccuracy.confidence).toBe(0.95);
    // Per-pack bounds are present.
    expect(Object.keys(data.byPack).length).toBeGreaterThanOrEqual(2);
  });

  it("the risk profile computes from records and carries the measured assurance bound", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    // Generate some governed traffic (unmandated, consequential → low mandate coverage).
    for (let i = 0; i < 4; i++) {
      await app!.inject({
        method: "POST",
        url: "/v1/actions",
        headers: auth,
        payload: {
          tenantId: TENANT,
          action: { type: "payment.transfer", agentId: "t", payload: { amount: 20000 + i } },
          liability: {
            mandate: null,
            oversightMode: "human_in_loop",
            blastRadius: {
              financialAmount: 20000 + i,
              currency: "USD",
              reversibility: "irreversible",
            },
            modelMetadata: null,
          },
        },
      });
    }
    const res = await app!.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/risk-profile`,
      headers: auth,
    });
    const p = res.json().data.riskProfile;
    expect(p.records).toBeGreaterThanOrEqual(4);
    expect(p.assuranceLowerBound).toBeGreaterThan(0.9);
    expect(["A", "B", "C", "D"]).toContain(p.grade);
  });

  it("the readiness gate blocks the underwriter feed on mandate-coverage failure, exception unblocks", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    // The 4 unmandated irreversible payments above fail mandate coverage.
    const readiness = await app!.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/readiness`,
      headers: auth,
    });
    expect(readiness.json().data.readiness.blocked).toBe(true);
    expect(
      readiness
        .json()
        .data.readiness.checks.find((c: { id: string }) => c.id === "mandate-coverage").passed,
    ).toBe(false);

    // The underwriter feed (an external release) is blocked.
    const blockedFeed = await app!.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/underwriter-feed`,
      headers: auth,
    });
    expect(blockedFeed.statusCode).toBe(409);
    expect(blockedFeed.json().error.code).toBe("readiness_gate_blocked");

    // A risk owner grants an exception for the failing check.
    const ex = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/readiness/exceptions`,
      headers: auth,
      payload: { checkId: "mandate-coverage", reason: "remediation in progress" },
    });
    expect(ex.statusCode).toBe(200);

    // Now the gate passes and the versioned feed is released.
    const ready = await app!.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/readiness`,
      headers: auth,
    });
    expect(ready.json().data.readiness.blocked).toBe(false);
    const feedRes = await app!.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/underwriter-feed`,
      headers: auth,
    });
    expect(feedRes.statusCode).toBe(200);
    const feed = feedRes.json().data.feed;
    expect(feed.feedVersion).toBe("1.0");
    expect(feed.assurance.verifiedAccuracyLowerBound).toBeGreaterThan(0.9);
    expect(feed.assurance.sampleSize).toBeGreaterThanOrEqual(1000);
  });
});
