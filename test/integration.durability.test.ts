import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * M0 exit-criteria integration test against real infrastructure (Postgres + WORM + Redis).
 *
 * Requires `pnpm infra:up`. If the infrastructure is unreachable the suite skips so the
 * pure unit tests still run in any environment.
 *
 * It proves: an action submitted through the API returns a verdict and persists a
 * signed record; a *fresh platform instance* (simulating a restart) finds the record
 * and verifies the whole chain genesis-to-head; and an external verifier validates the
 * chain using only exported records + public keys.
 */

// Point config at the docker-compose services and an isolated keystore.
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-it-keystore-"));
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

const TENANT = `it-${randomUUID().slice(0, 8)}`;

type Platform = import("../services/api/src/platform.js").Platform;

let available = true;
let firstPlatform: Platform | null = null;

async function tryBuild(): Promise<Platform | null> {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    return await buildPlatform();
  } catch (err) {
    console.warn("[integration] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
    return null;
  }
}

beforeAll(async () => {
  firstPlatform = await tryBuild();
});

afterAll(async () => {
  await firstPlatform?.close();
});

describe("durable round trip + restart + chain verification", () => {
  it("submits an action via the API and seals a record", async (ctx) => {
    if (!available || !firstPlatform) return ctx.skip();
    const { buildApp } = await import("../services/api/src/app.js");
    const app = await buildApp(firstPlatform);

    const res = await app.inject({
      method: "POST",
      url: "/v1/actions",
      payload: {
        tenantId: TENANT,
        action: { type: "payment.transfer", agentId: "agent-it", payload: { amount: 30000 } },
        liability: {
          mandate: { id: "m1", scope: "payments", limits: { maxAmount: 25000 }, grantor: "cfo", expiresAt: null, version: "1" },
          oversightMode: "human_in_loop",
          blastRadius: { financialAmount: 30000, currency: "USD", reversibility: "irreversible" },
          modelMetadata: { provider: "anthropic", model: "claude-opus-4-8" },
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    // $30k action against a $25k mandate is blocked at Tier 1.
    expect(body.data.verdict.decision).toBe("block");
    expect(body.data.record.content.sequence).toBe(0);
    expect(body.data.record.seal.signature).toBeTruthy();
    await app.close();
  });

  it("appends a second record linking to the first", async (ctx) => {
    if (!available || !firstPlatform) return ctx.skip();
    const { buildApp } = await import("../services/api/src/app.js");
    const app = await buildApp(firstPlatform);
    const res = await app.inject({
      method: "POST",
      url: "/v1/actions",
      payload: {
        tenantId: TENANT,
        action: { type: "email.send", agentId: "agent-it", payload: { to: "x@y.com" } },
        liability: {
          mandate: null,
          oversightMode: "autonomous",
          blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
          modelMetadata: null,
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.record.content.sequence).toBe(1);
    await app.close();
  });

  it("survives a simulated restart: a fresh platform finds the records and verifies the chain", async (ctx) => {
    if (!available || !firstPlatform) return ctx.skip();
    // Close the first instance and build a brand-new one — fresh pools, fresh process state.
    await firstPlatform.close();
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const restarted = await buildPlatform();
    firstPlatform = restarted; // so afterAll closes it

    const count = await restarted.store.count(TENANT);
    expect(count).toBe(2);

    const report = await restarted.integrity.verifyTenant(TENANT);
    expect(report.ok).toBe(true);
    expect(report.recordsChecked).toBe(2);
    expect(report.firstBrokenSequence).toBeNull();
  });

  it("verifies offline with only exported records + published keyset (zero-trust)", async (ctx) => {
    if (!available || !firstPlatform) return ctx.skip();
    const { verifyChain } = await import("../packages/core/src/index.js");
    const records = await firstPlatform.store.getChain(TENANT);
    const keyset = await firstPlatform.signer.publishKeyset();
    const report = verifyChain(records, keyset);
    expect(report.ok).toBe(true);
  });

  it("detects tampering of a persisted record body", async (ctx) => {
    if (!available || !firstPlatform) return ctx.skip();
    const { verifyChain } = await import("../packages/core/src/index.js");
    const records = await firstPlatform.store.getChain(TENANT);
    const keyset = await firstPlatform.signer.publishKeyset();
    // Mutate a record body as an attacker would (without the signing key).
    (records[0]!.content.action.payload as Record<string, unknown>).amount = 1;
    const report = verifyChain(records, keyset);
    expect(report.ok).toBe(false);
    expect(report.firstBrokenSequence).toBe(0);
  });
});
