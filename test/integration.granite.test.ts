import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * M8 (Granite) exit criteria:
 *   - a region-failover exercise completes with zero evidence loss and chain verification
 *     green on the recovered region;
 *   - metering produces invoices that reconcile to recorded usage exactly;
 *   - observability metrics are exported.
 */
const keystoreDir = mkdtempSync(join(tmpdir(), "pharos-gr-keystore-"));
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
process.env.PHAROS_ADMIN_TOKEN = "gr-admin";

type Platform = import("../services/api/src/platform.js").Platform;
const TENANT = `gr-${randomUUID().slice(0, 8)}`;
const N = 8;
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
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "Granite" });
    auth["x-api-key"] = (
      await platform.apiKeys.create(TENANT, "gr", [
        "actions:write",
        "records:read",
        "audit:read",
        "tenants:manage",
      ])
    ).plaintext;
  } catch (err) {
    console.warn("[granite] infrastructure unavailable, skipping:", (err as Error).message);
    available = false;
  }
});

afterAll(async () => {
  await app?.close();
  await platform?.close();
});

describe("Granite — observability, billing, region failover", () => {
  it("exports Prometheus metrics for verdicts and seals", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    for (let i = 0; i < N; i++) {
      await app!.inject({
        method: "POST",
        url: "/v1/actions",
        headers: auth,
        payload: {
          tenantId: TENANT,
          action: { type: "email.send", agentId: "a", payload: { i } },
          liability: {
            mandate: null,
            oversightMode: "autonomous",
            blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
            modelMetadata: null,
          },
        },
      });
    }
    const metrics = await app!.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("pharos_records_sealed_total");
    expect(metrics.body).toContain("pharos_verdicts_total");
    expect(metrics.body).toContain("pharos_verdict_latency_ms");
    // recordsSealed counter reflects this run's seals.
    const m = metrics.body.match(/pharos_records_sealed_total (\d+)/);
    expect(Number(m?.[1] ?? 0)).toBeGreaterThanOrEqual(N);
  });

  it("generates an invoice that reconciles to recorded usage exactly", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    const recorded = await platform.store.count(TENANT);
    const res = await app!.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT}/billing/invoice`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { invoice, reconciliation } = res.json().data;
    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.invoicedActions).toBe(recorded);
    expect(reconciliation.discrepancy).toBe(0);
    // The metered line bills exactly the recorded actions.
    expect(invoice.lines.find((l: { type: string }) => l.type === "metered_actions").quantity).toBe(
      recorded,
    );
    expect(invoice.total).toBeGreaterThan(0);
  });

  it("survives a region failover with zero evidence loss; chain verifies on the recovered region", async (ctx) => {
    if (!available || !platform) return ctx.skip();
    const before = await platform.store.count(TENANT);
    const head = await platform.store.getHead(TENANT);

    // Simulate region failover: tear down the active region and recover a fresh region
    // pointed at the same durable stores (RPO 0 — shared Postgres + WORM).
    await app!.close();
    await platform.close();
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform(); // recovered region
    app = await buildApp(platform);

    const after = await platform.store.count(TENANT);
    expect(after).toBe(before); // zero evidence loss

    const recoveredHead = await platform.store.getHead(TENANT);
    expect(recoveredHead?.hash).toBe(head?.hash); // same chain head

    const report = await platform.integrity.verifyTenant(TENANT);
    expect(report.ok).toBe(true); // chain verifies green on the recovered region
    expect(report.recordsChecked).toBe(before);
  });
});
