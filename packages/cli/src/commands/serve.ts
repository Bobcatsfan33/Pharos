import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildApp } from "@pharos/api";
import { readIfPresent, requireProject } from "../project.js";
import { openPlatform } from "../platform.js";
import { bold, dim, kv, ok, print, warn } from "../ui.js";

export const serveHelp = `pharos serve [--port <n>] [--host <addr>]

  Start the Pharos API over the project's embedded storage (default 127.0.0.1:4000). Prints
  an API key for the project tenant so SDKs, middlewares, and the gateway can submit actions.`;

/**
 * A 0600 file under the data dir, created once; the same posture as the keystore passphrase.
 * Read-or-create without a check-then-use race: `wx` refuses to overwrite, and a loser of
 * that race simply reads what the winner wrote.
 */
function secretFile(dataDir: string, name: string, mint: () => string): string {
  const file = join(dataDir, name);
  const existing = readIfPresent(file);
  if (existing !== null) return existing.trim();
  const value = mint();
  try {
    writeFileSync(file, `${value}\n`, { mode: 0o600, flag: "wx" });
    return value;
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
    return readFileSync(file, "utf8").trim();
  }
}

export async function serve(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: "4000" },
      host: { type: "string", default: "127.0.0.1" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error(`invalid --port ${values.port}`);
  const project = requireProject();
  const adminToken =
    process.env.PHAROS_ADMIN_TOKEN ??
    secretFile(project.dataDir, "admin.token", () => randomBytes(32).toString("base64url"));
  const platform = await openPlatform(project, {
    PHAROS_ADMIN_TOKEN: adminToken,
    PHAROS_ADMIN_TOKEN_EXPIRES_AT:
      process.env.PHAROS_ADMIN_TOKEN_EXPIRES_AT ?? "2099-12-31T23:59:59Z",
    PHAROS_API_PORT: String(port),
  });
  const tenantId = project.config.tenant;
  await platform.tenants.createTenant({ tenantId, displayName: tenantId });
  await platform.signer.ensureKey(`tenant:${tenantId}`);
  const keyFile = join(project.dataDir, "api-key");
  let apiKey = readIfPresent(keyFile)?.trim() ?? null;
  if (apiKey === null) {
    const minted = await platform.apiKeys.create(tenantId, "pharos serve", [
      "actions:write",
      "liability:assert",
      "records:read",
      "records:export",
      "chain:verify",
      "policies:read",
      "policies:write",
      "reviews:read",
      "reviews:act",
      "keys:manage",
      "audit:read",
      "tenants:manage",
    ]);
    apiKey = secretFile(project.dataDir, "api-key", () => minted.plaintext);
  }

  await platform.cache.connect();
  platform.integrity.start(60_000);
  platform.reviewSla.start(30_000);
  const app = await buildApp(platform);
  await app.listen({ port, host: values.host! });
  const posture = platform.storage.posture;
  print(
    ok(`Pharos API listening on ${bold(`http://${values.host}:${port}`)}`),
    kv("tenant", tenantId),
    kv("storage", `${posture.backend} — ${dim("tamper-evident, offline-verifiable; not WORM")}`),
    kv("api key", `${dim(keyFile)}  (${apiKey.slice(0, 8)}…)`),
    "",
    `  export PHAROS_URL=http://${values.host}:${port}`,
    `  export PHAROS_API_KEY=$(cat ${keyFile})`,
    `  export PHAROS_TENANT=${tenantId}`,
    "",
    dim(`  POST /v1/actions with x-api-key; GET /healthz; GET /v1/keyset. Ctrl-C to stop.`),
    values.host !== "127.0.0.1" && values.host !== "localhost"
      ? warn("bound to a non-loopback address with no TLS terminator — development only")
      : "",
  );
  return new Promise<number>((resolve) => {
    const stop = () => {
      void (async () => {
        await app.close();
        await platform.close();
        resolve(0);
      })();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
