import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// S3-T2: KMS-unavailable failure mode. Uses a DEDICATED KMS emulator on its own port so the
// test can kill it mid-run without disturbing the shared aws-kms emulator (:8088). Real
// Postgres + WORM via buildPlatform. Proves: KMS down at seal time ⇒ 503 kms_unavailable, the
// pharos_kms_unavailable_total metric increments, and NO partial record is written.
const KMS_PORT = 8099;
const KMS_CONTAINER = "pharos-killtest-kms";
const TENANT = `kms-failmode-${randomUUID().slice(0, 8)}`;

process.env.PHAROS_ENV = "local";
process.env.PHAROS_PG_URL ??= "postgres://pharos:pharos_local_dev@localhost:5433/pharos";
process.env.PHAROS_REDIS_URL ??= "redis://localhost:6380";
process.env.PHAROS_S3_ENDPOINT ??= "http://localhost:9010";
process.env.PHAROS_S3_REGION ??= "us-east-1";
process.env.PHAROS_S3_BUCKET ??= "pharos-evidence";
process.env.PHAROS_S3_ACCESS_KEY ??= "pharos";
process.env.PHAROS_S3_SECRET_KEY ??= "pharos_local_dev";
process.env.PHAROS_S3_FORCE_PATH_STYLE ??= "true";
process.env.PHAROS_ADMIN_TOKEN = "it-admin-token";
// This file drives aws-kms against the dedicated killable emulator.
process.env.PHAROS_KMS_PROVIDER = "aws-kms";
process.env.PHAROS_KMS_AWS_REGION = "us-east-1";
process.env.PHAROS_KMS_AWS_ENDPOINT = `http://localhost:${KMS_PORT}`;

type Platform = import("../services/api/src/platform.js").Platform;
type App = Awaited<ReturnType<typeof import("../services/api/src/app.js").buildApp>>;

let platform: Platform | null = null;
let app: App | null = null;
let apiKey = "";
let available = true;

function sh(cmd: string): string {
  return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString();
}
function startEmulator(): void {
  try {
    sh(`docker rm -f ${KMS_CONTAINER}`);
  } catch {
    /* not running */
  }
  sh(`docker run -d --name ${KMS_CONTAINER} -p ${KMS_PORT}:8080 nsmithuk/local-kms:latest`);
}
function killEmulator(): void {
  try {
    sh(`docker rm -f ${KMS_CONTAINER}`);
  } catch {
    /* already gone */
  }
}
async function waitReady(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`http://localhost:${KMS_PORT}`, { method: "GET" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

const submit = () =>
  app!.inject({
    method: "POST",
    url: "/v1/actions",
    headers: { "x-api-key": apiKey },
    payload: {
      tenantId: TENANT,
      action: { type: "email.send", agentId: "agent-it", payload: { n: 1 } },
      liability: {
        mandate: null,
        oversightMode: "autonomous",
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
        modelMetadata: null,
      },
    },
  });

const chainCount = async (): Promise<number> => {
  const res = await app!.inject({
    method: "GET",
    url: `/v1/chain/${TENANT}`,
    headers: { "x-api-key": apiKey },
  });
  return res.statusCode === 200 ? (res.json().data.count as number) : -1;
};

beforeAll(async () => {
  try {
    startEmulator();
    await waitReady();
    const { buildPlatform } = await import("../services/api/src/platform.js");
    const { buildApp } = await import("../services/api/src/app.js");
    platform = await buildPlatform();
    await platform.tenants.createTenant({ tenantId: TENANT, displayName: "KMS failmode" });
    apiKey = (
      await platform.apiKeys.create(TENANT, "it", ["actions:write", "records:read", "chain:verify"])
    ).plaintext;
    app = await buildApp(platform);
  } catch (err) {
    console.warn("[kms-failmode] setup unavailable, skipping:", (err as Error).message);
    available = false;
    killEmulator();
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  await platform?.close();
  killEmulator();
});

describe("KMS-unavailable failure mode (kill the emulator)", () => {
  it("seals normally while KMS is up, then 503s with no partial record when KMS is down", async (ctx) => {
    if (!available) return ctx.skip();

    // 1) KMS healthy: the action is governed and sealed under aws-kms.
    const ok = await submit();
    expect(ok.statusCode).toBe(201);
    const countAfterSeal = await chainCount();
    expect(countAfterSeal).toBeGreaterThanOrEqual(1);

    const kmsUnavailableBefore = readMetric(platform!, "pharos_kms_unavailable_total");

    // 2) Kill KMS. The next seal cannot happen ⇒ the action cannot be governed.
    killEmulator();

    const down = await submit();
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("kms_unavailable");

    // 3) The transactional invariant held: NO partial record was written by the failed seal.
    expect(await chainCount()).toBe(countAfterSeal);

    // 4) The metric incremented.
    const kmsUnavailableAfter = readMetric(platform!, "pharos_kms_unavailable_total");
    expect(kmsUnavailableAfter).toBeGreaterThan(kmsUnavailableBefore);
  }, 60_000);
});

// The metrics registry renders Prometheus text; read a counter's current total from it.
function readMetric(platform: Platform, name: string): number {
  const text = platform.metrics.render();
  let total = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith(name)) {
      const n = Number(line.trim().split(/\s+/).pop());
      if (Number.isFinite(n)) total += n;
    }
  }
  return total;
}
