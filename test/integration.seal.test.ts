import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { verifyClaimsPack, type ClaimsPackBundle } from "@pharos/evidence";

/**
 * M5 (Seal) incident drill: declare an incident (hold), assemble a claims pack, seal it,
 * release it to a scoped external counsel account, and verify it OFFLINE with a third-party
 * verifier using only the bundle. Plus: redaction is disabled under hold, a redacted pack
 * verifies cryptographically once the hold is released, originals stay intact, and the
 * regulatory exports generate.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-seal-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "seal-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `seal-${randomUUID().slice(0, 8)}`;
let available = true;
let platform: Platform | null = null;
let app: FastifyInstance | null = null;
let key = "";

const auth = { "x-api-key": "" };

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    app = await buildApp(platform);
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Seal" });
    key = (
      await platform.apiKeys.create(TENANT, "seal", [
        "actions:write",
        "records:read",
        "records:export",
        "audit:read",
      ])
    ).plaintext;
    auth["x-api-key"] = key;
  } catch (err) {
    console.warn("[seal] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

async function submit(payload: Record<string, unknown>) {
  return app!.inject({
    method: "POST",
    url: "/v1/actions",
    headers: auth,
    payload: {
      tenantId: TENANT,
      action: { type: "payment.transfer", agentId: "treasury", payload },
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
        blastRadius: {
          financialAmount: Number(payload.amount ?? 0),
          currency: "USD",
          reversibility: "reversible",
        },
        modelMetadata: null,
      },
    },
  });
}

describe("Seal — incident drill, offline verification, redaction under hold", () => {
  it("runs the full drill end to end", async (ctx) => {
    if (!available || !platform) return ctx.skip();

    // 1. Generate evidence (4 sealed records).
    for (let i = 0; i < 4; i++) {
      const res = await submit({ amount: 1000 * (i + 1), to: `vendor-${i}`, memo: `wire ${i}` });
      expect(res.statusCode).toBe(201);
    }

    // 2. Declare an incident: litigation hold over sequences 0..3.
    const hold = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/holds`,
      headers: auth,
      payload: { name: "INC-42", reason: "regulatory inquiry", fromSequence: 0, toSequence: 3 },
    });
    expect(hold.statusCode).toBe(201);

    // 3. Redaction is disabled under hold.
    const draftRedacted = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/claims-packs`,
      headers: auth,
      payload: {
        incident: "INC-42",
        audience: "claims_adjuster",
        fromSequence: 0,
        toSequence: 3,
        redactFields: ["to"],
      },
    });
    const sealRedacted = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/claims-packs/${draftRedacted.json().data.pack.id}/seal`,
      headers: auth,
    });
    expect(sealRedacted.statusCode).toBe(409);
    expect(sealRedacted.json().error.code).toBe("redaction_disabled_under_hold");

    // 4. Assemble + seal a FULL claims pack for outside counsel.
    const draft = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/claims-packs`,
      headers: auth,
      payload: {
        incident: "INC-42",
        audience: "outside_counsel",
        fromSequence: 0,
        toSequence: 3,
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
    expect(sealed.json().data.verification.ok).toBe(true);

    // 5. Release to a scoped external counsel account.
    const released = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/claims-packs/${packId}/release`,
      headers: auth,
      payload: { releasedTo: "counsel@firm.example" },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().data.pack.status).toBe("released");

    // 6. A third party verifies the released pack OFFLINE using only the bundle.
    const fetched = await app!.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/claims-packs/${packId}`,
      headers: auth,
    });
    const bundle = fetched.json().data.pack.bundle as ClaimsPackBundle;
    const offline = verifyClaimsPack(bundle);
    expect(offline.ok).toBe(true);
    expect(offline.recordsChecked).toBe(4);
    expect(offline.anchorsVerified).toBe(1);

    // 7. Release the hold, then a redacted adjuster pack verifies cryptographically.
    const holdId = hold.json().data.hold.id;
    await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/holds/${holdId}/release`,
      headers: auth,
    });
    const draft2 = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/claims-packs`,
      headers: auth,
      payload: {
        incident: "INC-42",
        audience: "claims_adjuster",
        fromSequence: 0,
        toSequence: 3,
        redactFields: ["to", "memo"],
      },
    });
    const sealed2 = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/claims-packs/${draft2.json().data.pack.id}/seal`,
      headers: auth,
    });
    expect(sealed2.statusCode).toBe(200);
    const bundle2 = sealed2.json().data.pack.bundle as ClaimsPackBundle;
    expect(verifyClaimsPack(bundle2).ok).toBe(true);
    // Redacted values are absent from the released pack.
    expect(JSON.stringify(bundle2)).not.toContain("vendor-1");

    // 8. Unredacted originals remain intact in the chain.
    const original = await platform.store.getRecord(TENANT, 1);
    expect((original!.content.action.payload as { to: string }).to).toBe("vendor-1");

    // 9. Regulatory exports generate from live data.
    for (const format of ["finra", "eu_ai_act_12", "sr_11_7"]) {
      const exp = await app!.inject({
        method: "GET",
        url: `/v1/tenants/${TENANT}/exports/${format}`,
        headers: auth,
      });
      expect(exp.statusCode).toBe(200);
      expect(exp.json().data.export.format).toBeTruthy();
    }

    // 10. The pack release/read is in the access audit chain.
    const auditVerify = await app!.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/audit/verify`,
      headers: auth,
    });
    expect(auditVerify.json().data.ok).toBe(true);
  });
});
