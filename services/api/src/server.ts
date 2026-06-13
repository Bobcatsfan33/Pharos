import { buildApp } from "./app.js";
import { buildPlatform } from "./platform.js";

/**
 * Server entrypoint. Boots the durable platform, starts continuous chain-integrity
 * verification, and serves the ingestion API.
 */
async function main(): Promise<void> {
  const platform = await buildPlatform();
  await platform.cache.connect().catch((err) => {
    console.warn("[startup] redis connect failed (cache disabled):", (err as Error).message);
  });
  platform.integrity.start(60_000);

  const app = await buildApp(platform);
  await app.listen({ port: platform.config.api.port, host: "0.0.0.0" });
  console.log(`Pharos API listening on :${platform.config.api.port} (${platform.config.env})`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        await app.close();
        await platform.close();
        process.exit(0);
      })();
    });
  }
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
