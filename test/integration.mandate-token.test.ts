import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PharosClient, type MandateRootKey, type MandateToken } from "@getpharos/sdk";
import { createGatewayApp } from "@pharos/gateway";
import {
  attenuateMandateToken,
  sealMandateToken,
  tokenBlockHashes,
  verifyMandateToken,
  type PublicKeyEntry,
} from "@pharos/core";

/**
 * Workstream A over the served API against the real compose stack (Postgres / Redis / MinIO /
 * local KMS): a token is minted for a stored mandate and signed by the tenant's mandate key, the
 * holder attenuates it offline, the server verifies it against its own published keyset, the
 * sealed record carries the block hashes and the effective authority, replay reproduces the
 * verdict from the record alone, the chain verifies, and the gateway path works with a token.
 * Skips only when the stack is unreachable — CI provisions it and fails on any skip.
 */
process.env.PHAROS_KMS_KEYSTORE_DIR = mkdtempSync(join(tmpdir(), "pharos-mt-keys-"));
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
let baseUrl = "";
const tenantId = `mt-${randomUUID().slice(0, 8)}`;
const AGENT = "treasury-agent";
const auth = () => ({ "x-api-key": apiKey, "content-type": "application/json" });

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
      payload: { tenantId, displayName: "Workstream A" },
    });
    apiKey = res.json().data.adminKey.plaintext;
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    available = true;
  } catch (err) {
    console.warn("[mandate-token] infrastructure unavailable, skipping:", (err as Error).message);
  }
});
afterAll(async () => {
  await app?.close();
  await platform?.close();
});

const liability = (
  amount: number,
  reversibility: "reversible" | "irreversible" = "reversible",
) => ({
  mandate: null,
  oversightMode: "autonomous" as const,
  blastRadius: { financialAmount: amount, currency: "USD", reversibility },
  modelMetadata: null,
});

async function submit(body: Record<string, unknown>) {
  const res = await app!.inject({
    method: "POST",
    url: "/v1/actions",
    headers: auth(),
    payload: { tenantId, ...body },
  });
  return res;
}

let minted: MandateToken;
let rootKey: PublicKeyEntry;
let attenuated: MandateToken;

describe("Workstream A — MandateToken over the served API", () => {
  it("mints a token for a stored mandate, signed by the tenant's published mandate key", async (ctx) => {
    if (!available) return ctx.skip();
    expect(
      (
        await app!.inject({
          method: "POST",
          url: `/v1/tenants/${tenantId}/mandates`,
          headers: auth(),
          payload: {
            mandateId: "vendor-payments",
            scope: "vendor payments",
            limits: { maxAmount: 25000, currency: "USD" },
            grantor: "cfo",
          },
        })
      ).statusCode,
    ).toBe(201);
    const res = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/mandates/vendor-payments/token`,
      headers: auth(),
      payload: { agentId: AGENT, actionTypes: ["payment.", "invoice.read"], ttlSeconds: 3600 },
    });
    expect(res.statusCode, res.body).toBe(201);
    minted = res.json().data.token;
    rootKey = res.json().data.rootKey;
    expect(minted.authority).toMatchObject({
      tenantId,
      agentId: AGENT,
      mandateId: "vendor-payments",
      grantor: "cfo",
      keyId: `mandate:${tenantId}#v1`,
    });
    expect(minted.authority.limits).toEqual({ financialAmount: 25000, currency: "USD" });
    // Offline verification needs only the published keyset — nothing else from Pharos.
    const keyset = (await app!.inject({ method: "GET", url: "/v1/keyset" })).json().data
      .keys as PublicKeyEntry[];
    const published = keyset.find((k) => k.keyId === minted.authority.keyId)!;
    expect(published).toEqual(rootKey);
    expect(verifyMandateToken(minted, published, new Date()).ok).toBe(true);

    // A token wider than the mandate is refused at mint time.
    const wider = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/mandates/vendor-payments/token`,
      headers: auth(),
      payload: { agentId: AGENT, financialAmount: 30000 },
    });
    expect(wider.statusCode).toBe(400);
    expect(wider.json().error.code).toBe("token_wider_than_mandate");
  });

  it("the holder attenuates offline; the server verifies, supersedes the mandate lookup, and seals the block hashes", async (ctx) => {
    if (!available) return ctx.skip();
    attenuated = attenuateMandateToken(minted, {
      checks: [
        { kind: "limit", value: { financialAmount: 5000 } },
        { kind: "scope", value: { actionTypes: ["payment.transfer"] } },
      ],
      issuedAt: new Date().toISOString(),
    });
    const ok = await submit({
      action: { type: "payment.transfer", agentId: AGENT, payload: { amount: 100 } },
      liability: liability(100),
      mandateToken: attenuated,
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const { verdict, record } = ok.json().data;
    expect(verdict.decision).toBe("allow");
    expect(record.content.schemaVersion).toBe("1.1.1");
    expect(record.content.liability.mandate).toMatchObject({
      id: "vendor-payments",
      version: "token",
      limits: { maxAmount: 5000, currency: "USD" },
    });
    expect(record.content.liability.mandateToken).toMatchObject({
      rootKeyId: `mandate:${tenantId}#v1`,
      verification: "verified",
      blockHashes: tokenBlockHashes(attenuated),
      effective: {
        scope: { actionTypes: ["payment.transfer"] },
        limits: { financialAmount: 5000 },
      },
    });

    // The attenuated ceiling, not the mandate's, is what Tier 1 enforces.
    const over = await submit({
      action: { type: "payment.transfer", agentId: AGENT, payload: { amount: 6000 } },
      liability: liability(6000),
      mandateToken: attenuated,
    });
    expect(over.json().data.verdict.decision).toBe("block");
    expect(
      over.json().data.verdict.ruleCitations.map((c: { ruleId: string }) => c.ruleId),
    ).toContain("mandate-limit-exceeded");

    // Out of the attenuated scope → Tier-1 block.
    const scope = await submit({
      action: { type: "invoice.read", agentId: AGENT, payload: {} },
      liability: liability(0),
      mandateToken: attenuated,
    });
    expect(
      scope.json().data.verdict.ruleCitations.map((c: { ruleId: string }) => c.ruleId),
    ).toEqual(["mandate-token-scope"]);
  });

  it("a truncated token, a sealed-then-tampered token, and a token for another tenant are sealed Tier-1 blocks", async (ctx) => {
    if (!available) return ctx.skip();
    const truncated: MandateToken = {
      ...attenuated,
      blocks: [],
      signatures: attenuated.signatures.slice(0, 1),
    };
    const sealedTampered: MandateToken = JSON.parse(JSON.stringify(sealMandateToken(attenuated)));
    (
      sealedTampered.blocks[0]!.checks[0] as { value: { financialAmount: number } }
    ).value.financialAmount = 24000;
    const foreign: MandateToken = {
      ...attenuated,
      authority: { ...attenuated.authority, keyId: "mandate:someone-else#v1" },
    };
    for (const [token, reason] of [
      [truncated, "proof"],
      [sealedTampered, "block-signature"],
      [foreign, "root-key-unknown"],
    ] as const) {
      const res = await submit({
        action: { type: "payment.transfer", agentId: AGENT, payload: { amount: 1 } },
        liability: liability(1),
        mandateToken: token,
      });
      expect(res.statusCode, res.body).toBe(201);
      const { verdict, record } = res.json().data;
      expect(verdict.decision, reason).toBe("block");
      expect(verdict.ruleCitations[0].ruleId).toBe("mandate-token-invalid");
      expect(record.content.liability.mandateToken.verification).toBe(reason);
      expect(record.content.liability.mandate).toBeNull();
    }
    const both = await submit({
      action: { type: "payment.transfer", agentId: AGENT, payload: {} },
      liability: liability(0),
      mandateId: "vendor-payments",
      mandateToken: attenuated,
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe("mandate_binding_ambiguous");
  });

  it("replay reproduces every token verdict from the sealed record, and the chain verifies", async (ctx) => {
    if (!available) return ctx.skip();
    const count = (
      await app!.inject({ method: "GET", url: `/v1/chain/${tenantId}`, headers: auth() })
    ).json().data.count as number;
    expect(count).toBeGreaterThanOrEqual(6);
    for (let seq = 0; seq < count; seq++) {
      const res = await app!.inject({
        method: "GET",
        url: `/v1/replay/${tenantId}/${seq}`,
        headers: auth(),
      });
      expect(res.statusCode, `sequence ${seq}: ${res.body}`).toBe(200);
      expect(res.json().data.identical).toBe(true);
    }
    const chain = await app!.inject({
      method: "GET",
      url: `/v1/chain/${tenantId}/verify`,
      headers: auth(),
    });
    expect(chain.statusCode).toBe(200);
    expect(chain.json().data.ok).toBe(true);
  });

  it("revoking the stored mandate turns a still-valid token into a sealed block", async (ctx) => {
    if (!available) return ctx.skip();
    // Offline verification cannot see this; the server can, and does.
    expect(verifyMandateToken(attenuated, rootKey, new Date()).ok).toBe(true);
    const revoke = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/mandates/vendor-payments/revoke`,
      headers: { "x-api-key": apiKey },
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect(await platform!.mandates.getActive(tenantId, "vendor-payments")).toBeNull();
    const res = await submit({
      action: { type: "payment.transfer", agentId: AGENT, payload: { amount: 1 } },
      liability: liability(1),
      mandateToken: attenuated,
    });
    expect(res.json().data.verdict.decision).toBe("block");
    expect(res.json().data.record.content.liability.mandateToken.verification).toBe(
      "mandate-revoked",
    );
  });

  it("the SDK and the gateway carry a token: an invalid one is blocked locally and still sealed; a valid one is governed by the server", async (ctx) => {
    if (!available) return ctx.skip();
    // Fresh mandate, since the previous one is revoked.
    await app!.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/mandates`,
      headers: auth(),
      payload: { mandateId: "ops", scope: "ops", limits: { maxAmount: 10 }, grantor: "coo" },
    });
    const mint = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/mandates/ops/token`,
      headers: auth(),
      payload: { agentId: AGENT, actionTypes: ["egress.post"] },
    });
    const token = mint.json().data.token as MandateToken;
    const root = mint.json().data.rootKey as MandateRootKey;

    const client = new PharosClient({ baseUrl, apiKey, mandateToken: { rootKeys: [root] } });
    const before = (
      await app!.inject({ method: "GET", url: `/v1/chain/${tenantId}`, headers: auth() })
    ).json().data.count as number;
    const local = await client.submit({
      tenantId,
      action: { type: "egress.post", agentId: AGENT, payload: {} },
      liability: liability(0),
      mandateToken: {
        ...token,
        signatures: [...token.signatures.slice(0, -1), token.signatures.at(-1)!.replace(/A/g, "B")],
      },
    });
    expect(local.localVerdict).toBe("mandate-token-invalid");
    const sealed = await local.sealed!;
    expect(sealed.verdict.decision).toBe("block");
    expect(sealed.record.content.sequence).toBe(before);

    let upstreamHits = 0;
    const target = Fastify();
    target.post("/orders", async () => {
      upstreamHits++;
      return { ok: true };
    });
    const targetUrl = await target.listen({ port: 0, host: "127.0.0.1" });
    const gateway = createGatewayApp({
      client,
      tenantId,
      agentId: AGENT,
      target: targetUrl,
      mapAction: () => ({
        action: { type: "egress.post" },
        liability: liability(0),
        mandateToken: token,
      }),
    });
    try {
      const forwarded = await gateway.inject({
        method: "POST",
        url: "/orders",
        payload: { sku: 1 },
      });
      expect(forwarded.statusCode, forwarded.body).toBe(200);
      expect(upstreamHits).toBe(1);
      const last = (
        await app!.inject({ method: "GET", url: `/v1/chain/${tenantId}`, headers: auth() })
      ).json().data.count as number;
      const rec = (
        await app!.inject({
          method: "GET",
          url: `/v1/records/${tenantId}/${last - 1}`,
          headers: auth(),
        })
      ).json().data;
      expect(rec.content.liability.mandateToken.verification).toBe("verified");
      expect(rec.content.liability.mandateToken.effective.mandateId).toBe("ops");
    } finally {
      await gateway.close();
      await target.close();
    }
  });
});
