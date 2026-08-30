/**
 * End-to-end smoke test for the unified Pharos product.
 *
 * Starts the real Pharos platform/API, provisions least-privilege runtime and reviewer
 * credentials, invokes the in-repository Pharos Runtime CLI over HTTP, and verifies both
 * sealed evidence and the durable execution timeline.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectCommand);
    child.on("close", (status) => resolveCommand({ status, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "pharos-runtime-e2e-"));
  process.env.PHAROS_KMS_KEYSTORE_DIR = join(work, "keystore");
  process.env.PHAROS_KMS_KEYSTORE_PASSPHRASE ??= `runtime-e2e-${randomUUID()}`;
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

    const tenantId = `runtime-e2e-${randomUUID().slice(0, 8)}`;
    await platform.tenants.createTenant({ tenantId, displayName: "Pharos Runtime E2E" });
    const credential = await platform.apiKeys.create(tenantId, "pharos-runtime", [
      "actions:write",
      "liability:assert",
    ]);
    const reviewer = await platform.apiKeys.create(tenantId, "pharos-runtime-reviewer", [
      "reviews:read",
      "reviews:act",
    ]);

    const runtimeRoot = resolve(process.env.PHAROS_RUNTIME_ROOT ?? "runtime/python");
    const graph = join(runtimeRoot, "examples", "pharos_governed.py");
    const runId = `pharos-runtime-${randomUUID().slice(0, 8)}`;
    const db = join(work, "keel.db");
    const blobs = join(work, "blobs");
    const pharosArgs = [
      "--pharos-url",
      baseUrl,
      "--pharos-api-key",
      credential.plaintext,
      "--pharos-tenant",
      tenantId,
    ];
    const run = await runCommand("pharos", [
      "run",
      "--mock",
      graph,
      "--run-id",
      runId,
      "--db",
      db,
      "--blobs",
      blobs,
      ...pharosArgs,
    ]);
    if (run.status !== 1 || !run.stdout.includes(`run ${runId} -> paused`)) {
      throw new Error(`Pharos Runtime did not park for review:\n${run.stdout}\n${run.stderr}`);
    }

    const pendingResponse = await fetch(`${baseUrl}/v1/tenants/${tenantId}/escalations`, {
      headers: { "x-api-key": reviewer.plaintext },
    });
    const pendingBody = (await pendingResponse.json()) as {
      data?: { escalations?: Array<{ id: string }> };
    };
    const pending = pendingBody.data?.escalations ?? [];
    if (!pendingResponse.ok || pending.length !== 1) {
      throw new Error(`expected one pending human review, got ${pending.length}`);
    }
    const reviewResponse = await fetch(
      `${baseUrl}/v1/tenants/${tenantId}/escalations/${pending[0].id}/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": reviewer.plaintext },
        body: JSON.stringify({
          decision: "approve",
          rationale: "E2E reviewer approved the governed publication",
        }),
      },
    );
    if (!reviewResponse.ok) {
      throw new Error(
        `human review failed (${reviewResponse.status}): ${await reviewResponse.text()}`,
      );
    }

    const resumed = await runCommand("pharos", [
      "resume",
      runId,
      "--mock",
      "--db",
      db,
      "--blobs",
      blobs,
      ...pharosArgs,
    ]);
    if (resumed.status !== 0 || !resumed.stdout.includes(`run ${runId} -> completed`)) {
      throw new Error(
        `Pharos Runtime did not complete after approval:\n${resumed.stdout}\n${resumed.stderr}`,
      );
    }

    const records = await platform.store.getChain(tenantId);
    const authorizations = records.filter(
      (record) => record.content.action.type !== "review.verdict",
    );
    const humanVerdicts = records.filter(
      (record) => record.content.action.type === "review.verdict",
    );
    if (authorizations.length !== 2 || humanVerdicts.length !== 1) {
      throw new Error(
        `expected two authorizations and one human verdict, got ${authorizations.length}/${humanVerdicts.length}`,
      );
    }
    for (const record of authorizations) {
      const action = record.content.action;
      const keel = action.payload.keel as Record<string, unknown> | undefined;
      if (action.sessionId !== runId || keel?.runId !== runId || !keel.nodeId) {
        throw new Error("sealed authorization is missing its runtime run/node binding");
      }
    }

    const timeline = await runCommand("pharos", ["show", runId, "--db", db, "--blobs", blobs]);
    if (timeline.status !== 0) throw new Error(`pharos show failed:\n${timeline.stderr}`);
    const decisions = timeline.stdout.match(/governance\.decided/g) ?? [];
    const escalated = timeline.stdout.match(/governance\.escalated/g) ?? [];
    const completed = timeline.stdout.match(/step\.completed/g) ?? [];
    const resumedEvents = timeline.stdout.match(/run\.resumed/g) ?? [];
    if (
      decisions.length !== 2 ||
      escalated.length !== 1 ||
      completed.length !== 2 ||
      resumedEvents.length !== 1
    ) {
      throw new Error(`incomplete governed timeline:\n${timeline.stdout}`);
    }
    console.log(
      `Pharos Runtime E2E passed: ${authorizations.length} sealed authorizations, ` +
        `${humanVerdicts.length} sealed human verdict, ${completed.length} completed durable steps`,
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
