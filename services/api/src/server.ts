import { checkJudgeReadiness } from "@pharos/judge";
import { buildApp } from "./app.js";
import { buildPlatform } from "./platform.js";

/**
 * Server entrypoint. Boots the durable platform, starts continuous chain-integrity
 * verification and scheduled trusted-time anchoring, and serves the ingestion API.
 */
async function main(): Promise<void> {
  const platform = await buildPlatform();
  await platform.cache.connect().catch((err) => {
    console.warn("[startup] redis connect failed (cache disabled):", (err as Error).message);
  });
  platform.integrity.start(60_000);
  platform.reviewSla.start(30_000);
  const anchorIntervalMs = platform.config.tsa.intervalMs;
  if (anchorIntervalMs > 0) {
    platform.anchorScheduler.start(anchorIntervalMs);
    console.log(`[startup] scheduled anchoring every ${Math.round(anchorIntervalMs / 60000)} min`);
  }

  // Served-judge readiness gate (WS6, fail-closed): when transformer packs are configured
  // (PHAROS_SERVED_JUDGE_PACKS), every one must fetch + sha256-verify + construct a session + warm-
  // infer + match its model card BEFORE we accept traffic. If any fails, the server does not start.
  const servedPacks = (process.env.PHAROS_SERVED_JUDGE_PACKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (servedPacks.length > 0) {
    const readiness = await checkJudgeReadiness(servedPacks);
    if (!readiness.ready) {
      for (const c of readiness.checks.filter((x) => !x.passed)) {
        console.error(`[readiness] pack ${c.packId} NOT ready: ${c.error ?? JSON.stringify(c)}`);
      }
      throw new Error(
        "served-judge readiness gate failed — refusing to accept traffic (fail-closed)",
      );
    }
    console.log(`[readiness] ${servedPacks.length} served judge pack(s) ready`);
  }

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
