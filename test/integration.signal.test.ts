import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { validatePdpResponse, type PdpResponse } from "@pharos/pdp-spec";

/**
 * M9 (Signal): the public PDP endpoint serves the open contract with a signed evidence
 * binding, validated by the spec's own validator.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-sig-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "sig-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `sig-${randomUUID().slice(0, 8)}`;
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
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Signal" });
    auth["x-api-key"] = (await platform.apiKeys.create(TENANT, "sig", ["actions:write"])).plaintext;
  } catch (err) {
    console.warn("[signal] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

describe("Signal — public PDP endpoint", () => {
  it("serves the open PDP contract with a signed evidence binding", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await app!.inject({
      method: "POST",
      url: "/v1/pdp",
      headers: auth,
      payload: { action: { type: "email.send", agentId: "a", payload: { body: "We guarantee a 20% return with no risk, guaranteed profits!" } }, liability: { mandate: null, oversightMode: "autonomous", blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" } } },
    });
    expect(res.statusCode).toBe(200);
    const response = res.json().data as PdpResponse;
    // The response validates against the open spec's own validator.
    const validation = validatePdpResponse(response);
    expect(validation.valid).toBe(true);
    expect(response.decision).toBe("block"); // FINRA promissory
    expect(response.evidenceBinding).toBeTruthy();
    expect(response.evidenceBinding!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(response.evidenceBinding!.algorithm).toBe("ed25519");
  });

  it("publishes the spec version", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await app!.inject({ method: "GET", url: "/v1/pdp/spec" });
    expect(res.json().data.specVersion).toBe("1.0.0");
  });

  it("rejects an unauthenticated PDP call", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await app!.inject({ method: "POST", url: "/v1/pdp", payload: { action: { type: "x", agentId: "a" }, liability: { oversightMode: "autonomous", blastRadius: { reversibility: "reversible" } } } });
    expect(res.statusCode).toBe(401);
  });
});
