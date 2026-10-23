import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@pharos/config";
import { verifyChain, type ActionRecord, type PublicKeyEntry } from "@pharos/core";
import { buildApp } from "../services/api/src/app.js";
import { buildPlatform, type Platform } from "../services/api/src/platform.js";

/**
 * The on-ramp, end to end, with no infrastructure: boot the real API over the embedded
 * backend, provision a tenant, submit actions, and verify the chain offline from what the
 * API publishes. This file must NEVER skip — it needs nothing but Node.
 */
const ADMIN = "local-admin-token-for-embedded-test";
let dataDir: string;
let platform: Platform;
let app: FastifyInstance;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "pharos-embedded-api-"));
  const config = loadConfig({
    PHAROS_STORAGE_BACKEND: "embedded",
    PHAROS_DATA_DIR: dataDir,
    PHAROS_ADMIN_TOKEN: ADMIN,
    PHAROS_TSA_ANCHOR_INTERVAL_MS: "0",
  });
  platform = await buildPlatform(config);
  app = await buildApp(platform);
});
afterAll(async () => {
  await app?.close();
  await platform?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("API over the embedded backend (no Docker)", () => {
  let apiKey: string;
  const tenantId = "embedded-tenant";

  it("reports its storage posture honestly on /healthz", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      counters: true,
      storage: { backend: "embedded", worm: false, rowLevelSecurity: false },
    });
    expect(platform.pool).toBeUndefined();
    expect(platform.storage.posture.description).toMatch(/NOT write-once/);
  });

  it("provisions a tenant with the admin token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: { "x-pharos-admin": ADMIN, "content-type": "application/json" },
      payload: { tenantId, displayName: "Embedded" },
    });
    expect(res.statusCode, res.body).toBe(201);
    apiKey = res.json().data.adminKey.plaintext;
    expect(apiKey).toMatch(/^pk_/);
  });

  it("governs actions: a mandate-limited transfer is blocked at Tier 1 and sealed", async () => {
    const mandate = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/mandates`,
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      payload: {
        mandateId: "m-funds",
        scope: "vendor payments",
        limits: { maxAmount: 25_000 },
        grantor: "treasury-controller",
      },
    });
    expect(mandate.statusCode, mandate.body).toBe(201);

    const submit = (amount: number, type = "payment.transfer") =>
      app.inject({
        method: "POST",
        url: "/v1/actions",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        payload: {
          tenantId,
          action: { type, agentId: "treasury-bot", payload: { amount, to: "vendor-1" } },
          liability: {
            mandate: null,
            oversightMode: "human_in_loop",
            blastRadius: {
              financialAmount: amount,
              currency: "USD",
              reversibility: "irreversible",
            },
            modelMetadata: null,
          },
          mandateId: "m-funds",
        },
      });

    const ok = await submit(1_000, "crm.update");
    expect(ok.statusCode, ok.body).toBe(201);
    const blocked = await submit(30_000);
    expect(blocked.statusCode, blocked.body).toBe(201);
    const body = blocked.json().data;
    expect(body.verdict.decision).toBe("block");
    expect(body.verdict.tierReached).toBe(1);
    expect(body.verdict.ruleCitations[0]).toMatchObject({ ruleId: "mandate-limit-exceeded" });
    expect(body.record.content.sequence).toBe(1);
    expect(body.record.seal.sigVersion).toBe(2);
  });

  it("the chain verifies through the API and offline from the published keyset", async () => {
    const verify = await app.inject({
      method: "GET",
      url: `/v1/chain/${tenantId}/verify`,
      headers: { "x-api-key": apiKey },
    });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json().data.ok).toBe(true);

    const keyset = await app.inject({ method: "GET", url: "/v1/keyset" });
    const keys = keyset.json().data.keys as PublicKeyEntry[];
    const records: ActionRecord[] = [];
    for (let seq = 0; seq < 2; seq++) {
      const r = await app.inject({
        method: "GET",
        url: `/v1/records/${tenantId}/${seq}`,
        headers: { "x-api-key": apiKey },
      });
      records.push(r.json().data as ActionRecord);
    }
    const report = verifyChain(records, keys);
    expect(report.ok, report.errors.join("; ")).toBe(true);
    expect(report.recordsChecked).toBe(2);
    // The evidence files on disk agree with the operational copy.
    expect((await platform.store.reconcileEvidence(tenantId)).ok).toBe(true);
  });

  it("survives a restart from the same data directory with the chain intact", async () => {
    await app.close();
    await platform.close();
    const config = loadConfig({
      PHAROS_STORAGE_BACKEND: "embedded",
      PHAROS_DATA_DIR: dataDir,
      PHAROS_ADMIN_TOKEN: ADMIN,
      PHAROS_TSA_ANCHOR_INTERVAL_MS: "0",
    });
    platform = await buildPlatform(config);
    app = await buildApp(platform);
    const report = await platform.integrity.verifyTenant(tenantId);
    expect(report.ok, report.errors.join("; ")).toBe(true);
    expect(report.recordsChecked).toBe(2);
    // Keys reloaded from the keystore under the file-backed passphrase; the old API key still works.
    const res = await app.inject({
      method: "GET",
      url: `/v1/chain/${tenantId}`,
      headers: { "x-api-key": apiKey },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});
