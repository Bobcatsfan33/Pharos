import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildApp } from "@pharos/api";
import { requireProject } from "../project.js";
import { openPlatform } from "../platform.js";
import { bold, dim, kv, ok, print, warn } from "../ui.js";

export const serveHelp = `pharos serve [--port <n>] [--host <addr>]

  Start the Pharos API over the project's embedded storage (default 127.0.0.1:4000). Prints
  an API key for the project tenant so SDKs, middlewares, and the gateway can submit actions.`;

/** A 0600 file under the data dir, created once; the same posture as the keystore passphrase. */
function secretFile(dataDir: string, name: string): string {
  const file = join(dataDir, name);
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const value = randomBytes(32).toString("base64url");
  writeFileSync(file, `${value}\n`, { mode: 0o600, flag: "wx" });
  return value;
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
  const adminToken = process.env.PHAROS_ADMIN_TOKEN ?? secretFile(project.dataDir, "admin.token");
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
  let apiKey: string;
  if (existsSync(keyFile)) {
    apiKey = readFileSync(keyFile, "utf8").trim();
  } else {
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
    apiKey = minted.plaintext;
    writeFileSync(keyFile, `${apiKey}\n`, { mode: 0o600, flag: "wx" });
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
