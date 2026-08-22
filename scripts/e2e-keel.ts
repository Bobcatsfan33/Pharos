/**
 * Cross-repository smoke test for the combined product.
 *
 * Starts the real Pharos platform/API, provisions a least-privilege Keel credential,
 * invokes the real Keel CLI over HTTP, and verifies both sealed Pharos records and the
 * durable Keel event timeline. CI checks out a pinned Keel revision into .e2e/keel.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "pharos-keel-e2e-"));
  process.env.PHAROS_KMS_KEYSTORE_DIR = join(work, "keystore");
  process.env.PHAROS_KMS_KEYSTORE_PASSPHRASE ??= `keel-e2e-${randomUUID()}`;
  process.env.PHAROS_KMS_PROVIDER = "local-kms";
  process.env.PHAROS_TSA_PROVIDER = "local";

  const [{ buildPlatform }, { buildApp }] = await Promise.all([
    import("../services/api/src/platform.js"),
    import("../services/api/src/app.js"),
  ]);
  const platform = await buildPlatform();
  const app = await buildApp(platform);
  try {
    await platform.cache.connect().catch(() => {});
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address !== "object" || address === null) throw new Error("API did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const tenantId = `keel-e2e-${randomUUID().slice(0, 8)}`;
    await platform.tenants.createTenant({ tenantId, displayName: "Keel E2E" });
    const credential = await platform.apiKeys.create(tenantId, "keel-runtime", [
      "actions:write",
      "liability:assert",
    ]);

    const keelRoot = resolve(process.env.KEEL_CHECKOUT ?? ".e2e/keel");
    const graph = join(keelRoot, "examples", "pharos_governed.py");
    const runId = `pharos-keel-${randomUUID().slice(0, 8)}`;
    const db = join(work, "keel.db");
    const blobs = join(work, "blobs");
    const run = spawnSync(
      "keel",
      [
        "run",
        "--mock",
        graph,
        "--run-id",
        runId,
        "--db",
        db,
        "--blobs",
        blobs,
        "--pharos-url",
        baseUrl,
        "--pharos-api-key",
        credential.plaintext,
        "--pharos-tenant",
        tenantId,
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONUNBUFFERED: "1" } },
    );
    if (run.status !== 0) {
      throw new Error(`Keel failed (${run.status}):\n${run.stdout}\n${run.stderr}`);
    }
    if (!run.stdout.includes(`run ${runId} -> completed`)) {
      throw new Error(`Keel did not report a completed run:\n${run.stdout}`);
    }

    const records = await platform.store.getChain(tenantId);
    if (records.length !== 2) {
      throw new Error(`expected two sealed Pharos authorizations, got ${records.length}`);
    }
    for (const record of records) {
      const action = record.content.action;
      const keel = action.payload.keel as Record<string, unknown> | undefined;
      if (action.sessionId !== runId || keel?.runId !== runId || !keel.nodeId) {
        throw new Error("sealed authorization is missing its Keel run/node binding");
      }
    }

    const timeline = spawnSync("keel", ["show", runId, "--db", db, "--blobs", blobs], {
      encoding: "utf8",
    });
    if (timeline.status !== 0) throw new Error(`keel show failed:\n${timeline.stderr}`);
    const decisions = timeline.stdout.match(/governance\.decided/g) ?? [];
    const completed = timeline.stdout.match(/step\.completed/g) ?? [];
    if (decisions.length !== 2 || completed.length !== 2) {
      throw new Error(`incomplete governed timeline:\n${timeline.stdout}`);
    }
    console.log(
      `Keel + Pharos E2E passed: ${records.length} sealed authorizations, ` +
        `${completed.length} completed durable steps`,
    );
  } finally {
    await app.close();
    await platform.close();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
