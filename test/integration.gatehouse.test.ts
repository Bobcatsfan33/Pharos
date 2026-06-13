import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * M1 (Gatehouse) exit criteria against real infrastructure:
 *   - two tenants side by side; cross-tenant reads, IDOR probes, and role escalation
 *     all find zero crossings;
 *   - API-key rotation mid-stream drops no records;
 *   - every evidence access lands in the hash-chained access audit, which verifies and
 *     detects tampering.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-gh-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "gh-admin-token";

type Platform = import("../services/api/src/platform.js").Platform;

const TA = `gha-${randomUUID().slice(0, 8)}`;
const TB = `ghb-${randomUUID().slice(0, 8)}`;

let available = true;
let platform: Platform | null = null;
let app: FastifyInstance | null = null;
let keyA = "";
let keyB = "";

const benignAction = (agent: string) => ({
  action: { type: "email.send", agentId: agent, payload: { to: "x@y.com" } },
  liability: {
    mandate: null,
    oversightMode: "autonomous" as const,
    blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" as const },
    modelMetadata: null,
  },
});

async function provision(tenantId: string): Promise<string> {
  const res = await app!.inject({
    method: "POST",
    url: "/v1/admin/tenants",
    headers: { "x-pharos-admin": "gh-admin-token" },
    payload: { tenantId, displayName: tenantId },
  });
  return res.json().data.adminKey.plaintext;
}

beforeAll(async () => {
  try {
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    app = await buildApp(platform);
    keyA = await provision(TA);
    keyB = await provision(TB);
  } catch (err) {
    console.warn("[gatehouse] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

async function submit(tenantId: string, apiKey: string, agent = "agent-1") {
  return app!.inject({
    method: "POST",
    url: "/v1/actions",
    headers: { "x-api-key": apiKey },
    payload: { tenantId, ...benignAction(agent) },
  });
}

describe("Gatehouse — tenant isolation attack suite", () => {
  it("each tenant can submit and read its own evidence", async (ctx) => {
    if (!available) return ctx.skip();
    expect((await submit(TA, keyA)).statusCode).toBe(201);
    expect((await submit(TB, keyB)).statusCode).toBe(201);

    const readA = await app!.inject({ method: "GET", url: `/v1/records/${TA}/0`, headers: { "x-api-key": keyA } });
    expect(readA.statusCode).toBe(200);
  });

  it("blocks cross-tenant reads (B's key cannot read A's record)", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await app!.inject({ method: "GET", url: `/v1/records/${TA}/0`, headers: { "x-api-key": keyB } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("tenant_mismatch");
  });

  it("blocks IDOR on the chain endpoint across tenants", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await app!.inject({ method: "GET", url: `/v1/chain/${TA}`, headers: { "x-api-key": keyB } });
    expect(res.statusCode).toBe(403);
  });

  it("blocks submitting actions into another tenant", async (ctx) => {
    if (!available) return ctx.skip();
    // B's key trying to write into tenant A.
    const res = await submit(TA, keyB);
    expect(res.statusCode).toBe(403);
  });

  it("rejects unauthenticated requests (401)", async (ctx) => {
    if (!available) return ctx.skip();
    const res = await app!.inject({ method: "GET", url: `/v1/records/${TA}/0` });
    expect(res.statusCode).toBe(401);
  });

  it("prevents role/scope escalation: a read-only key cannot write or manage keys", async (ctx) => {
    if (!available) return ctx.skip();
    const reader = await platform!.apiKeys.create(TA, "reader", ["records:read"]);
    const writeAttempt = await submit(TA, reader.plaintext);
    expect(writeAttempt.statusCode).toBe(403);
    const keyMgmt = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TA}/keys`,
      headers: { "x-api-key": reader.plaintext },
      payload: { name: "x", scopes: ["actions:write"] },
    });
    expect(keyMgmt.statusCode).toBe(403);
  });

  it("RLS backstops at the database: tenant-A context cannot see tenant-B rows", async (ctx) => {
    if (!available) return ctx.skip();
    const client = await platform!.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('pharos.tenant_id', $1, true)", [TA]);
      await client.query("SET LOCAL ROLE pharos_app");
      // Even explicitly querying for B's tenant_id returns nothing under A's context.
      const res = await client.query("SELECT count(*)::int AS n FROM action_records WHERE tenant_id = $1", [TB]);
      expect(res.rows[0].n).toBe(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

describe("Gatehouse — API key rotation mid-stream", () => {
  it("rotates a key while submitting and drops no records", async (ctx) => {
    if (!available) return ctx.skip();
    const ingest = await platform!.apiKeys.create(TA, "ingest", ["actions:write"]);
    const before = (await platform!.store.count(TA)) ?? 0;

    // Submit with the original key.
    expect((await submit(TA, ingest.plaintext)).statusCode).toBe(201);

    // Rotate; the old key stays active during the overlap window.
    const rotated = await platform!.apiKeys.rotate(TA, ingest.record.keyId);
    expect(rotated).not.toBeNull();

    // Interleave old + new key submissions — none dropped.
    const results = await Promise.all([
      submit(TA, ingest.plaintext),
      submit(TA, rotated!.plaintext),
      submit(TA, ingest.plaintext),
      submit(TA, rotated!.plaintext),
    ]);
    for (const r of results) expect(r.statusCode).toBe(201);

    // Now revoke the old key: it must stop working, the new key keeps working.
    await platform!.apiKeys.revoke(TA, ingest.record.keyId);
    expect((await submit(TA, ingest.plaintext)).statusCode).toBe(401);
    expect((await submit(TA, rotated!.plaintext)).statusCode).toBe(201);

    const after = await platform!.store.count(TA);
    // 1 + 4 + 1 (final new-key submit) = 6 successful new submissions.
    expect(after).toBe(before + 6);
  });
});

describe("Gatehouse — access audit chain", () => {
  it("records evidence views and verifies the audit chain", async (ctx) => {
    if (!available) return ctx.skip();
    // Generate some audited reads.
    await app!.inject({ method: "GET", url: `/v1/records/${TB}/0`, headers: { "x-api-key": keyB } });
    await app!.inject({ method: "GET", url: `/v1/chain/${TB}/verify`, headers: { "x-api-key": keyB } });

    const verify = await app!.inject({ method: "GET", url: `/v1/tenants/${TB}/audit/verify`, headers: { "x-api-key": keyB } });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.ok).toBe(true);
    expect(verify.json().data.entriesChecked).toBeGreaterThan(0);

    // The audit log itself is tenant-isolated.
    const listed = await platform!.accessAudit.list(TB);
    expect(listed.every((e) => e.tenantId === TB)).toBe(true);
  });

  it("detects tampering with an audit entry", async (ctx) => {
    if (!available) return ctx.skip();
    // Tamper directly in the DB (as an attacker with DB access would).
    const client = await platform!.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('pharos.tenant_id', $1, true)", [TB]);
      await client.query(
        "UPDATE access_audit SET actor = 'tampered' WHERE tenant_id = $1 AND sequence = 0",
        [TB],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const report = await platform!.accessAudit.verify(TB);
    expect(report.ok).toBe(false);
    expect(report.firstBrokenSequence).toBe(0);
  });
});
