import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { verifyClaimsPack, type ClaimsPackBundle } from "@pharos/evidence";

/**
 * S4-T2 acceptance: scheduled per-tenant anchoring.
 *
 * Drives the real platform: seal records, observe that the chain view flags a missing anchor,
 * run the anchor job (the same sweep the scheduler runs hourly), observe the warning clears and
 * the head is anchored, seal more records to re-open the gap, then export a claims pack and
 * verify OFFLINE that it proves "these records existed before time T".
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-anchor-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "anchor-admin";
// Keep the background scheduler off; the test drives anchorAll() explicitly.
process.env.PHAROS_TSA_ANCHOR_INTERVAL_MS = "0";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `anchor-${randomUUID().slice(0, 8)}`;
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
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Anchor" });
    auth["x-api-key"] = (
      await platform.apiKeys.create(TENANT, "anchor", [
        "actions:write",
        "records:read",
        "records:export",
        "chain:verify",
      ])
    ).plaintext;
  } catch (err) {
    console.warn("[anchor] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

async function submit(amount: number) {
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
        oversightMode: "human_on_loop",
        blastRadius: { financialAmount: amount, currency: "USD", reversibility: "reversible" },
        modelMetadata: null,
      },
    },
  });
}

async function verifyChainView() {
  const res = await app!.inject({
    method: "GET",
    url: `/v1/chain/${TENANT}/verify`,
    headers: auth,
  });
  return res.json().data as {
    ok: boolean;
    warnings: string[];
    anchoring: {
      headSequence: number | null;
      latestAnchorSequence: number | null;
      latestAnchorTime: string | null;
      headAnchored: boolean;
    };
  };
}

describe("Scheduled anchoring — chain-view gaps, offline existed-before-T proof", () => {
  it("flags a missing anchor, clears it after the sweep, and re-opens the gap on new records", async (ctx) => {
    if (!available || !platform) return ctx.skip();

    // 1. Seal 3 records (sequences 0..2). No anchor exists yet.
    for (let i = 0; i < 3; i++) expect((await submit(1000 + i)).statusCode).toBe(201);

    const before = await verifyChainView();
    expect(before.ok).toBe(true); // cryptographically sound...
    expect(before.anchoring.headSequence).toBe(2);
    expect(before.anchoring.headAnchored).toBe(false); // ...but no trusted-time anchor yet
    expect(before.warnings.some((w) => /no trusted-time anchor/.test(w))).toBe(true);

    // 2. Run the anchor job (the sweep the scheduler runs hourly).
    const sweep = await platform.anchorScheduler.anchorAll();
    const ours = sweep.find((r) => r.tenantId === TENANT);
    expect(ours?.anchored?.sequence).toBe(2);

    // 3. The gap warning clears and the head is anchored.
    const after = await verifyChainView();
    expect(after.anchoring.latestAnchorSequence).toBe(2);
    expect(after.anchoring.headAnchored).toBe(true);
    expect(after.warnings).toHaveLength(0);
    expect(Number.isNaN(Date.parse(after.anchoring.latestAnchorTime!))).toBe(false);

    // 4. Seal 2 more records (head → sequence 4): the anchor now lags behind the head.
    for (let i = 0; i < 2; i++) expect((await submit(2000 + i)).statusCode).toBe(201);
    const lagging = await verifyChainView();
    expect(lagging.anchoring.headSequence).toBe(4);
    expect(lagging.anchoring.headAnchored).toBe(false);
    expect(lagging.warnings.some((w) => /2 record\(s\) sealed since the last/.test(w))).toBe(true);

    // 5. Export a claims pack and verify OFFLINE that it proves existed-before-T.
    const draft = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/claims-packs`,
      headers: auth,
      payload: {
        incident: "INC-anchor",
        audience: "outside_counsel",
        fromSequence: 0,
        toSequence: 4,
        redactFields: [],
      },
    });
    const packId = draft.json().data.pack.id;
    const sealed = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/claims-packs/${packId}/seal`,
      headers: auth,
    });
    expect(sealed.statusCode).toBe(200);

    const bundle = sealed.json().data.pack.bundle as ClaimsPackBundle;
    const offline = verifyClaimsPack(bundle);
    expect(offline.ok).toBe(true);
    expect(offline.recordsChecked).toBe(5);
    // The bundle carries a trusted-time anchor over the head: the offline verifier confirms it,
    // establishing that these records existed no later than the anchor's stamped time.
    expect(offline.anchorsVerified).toBeGreaterThanOrEqual(1);
    const anchorTime = bundle.anchors[0]!.time;
    expect(Number.isNaN(Date.parse(anchorTime))).toBe(false);
  });
});
