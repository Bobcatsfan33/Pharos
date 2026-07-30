import { PharosClient } from "@getpharos/sdk";
import {
  PostgresHeldRequestStore,
  createPool,
  heldRequestKeyProviderFromMaster,
  runMigrations,
  type HeldRequestStore,
  type Pool,
} from "@pharos/storage";
import { loadGatewayDurabilityConfig } from "./config.js";
import { createGatewayApp } from "./gateway.js";

/**
 * Standalone gateway server. Routes an agent's HTTP egress through Pharos with zero code
 * changes in the agent. Configure via env:
 *   PHAROS_API_BASE, PHAROS_API_KEY, PHAROS_TENANT, GATEWAY_AGENT_ID, GATEWAY_TARGET, GATEWAY_PORT,
 *   PHAROS_PG_URL, PHAROS_GATEWAY_HOLD_MASTER_KEY_B64
 */
async function main(): Promise<void> {
  let heldRequestStore: HeldRequestStore | undefined;
  let pool: Pool | undefined;
  const durability = loadGatewayDurabilityConfig(process.env);
  if (durability) {
    pool = createPool(durability.pgUrl);
    await runMigrations(pool);
    heldRequestStore = new PostgresHeldRequestStore(
      pool,
      heldRequestKeyProviderFromMaster(durability.masterKey),
    );
  }

  const client = new PharosClient({
    baseUrl: process.env.PHAROS_API_BASE ?? "http://localhost:4000",
    apiKey: process.env.PHAROS_API_KEY ?? "",
    deadlineMs: Number(process.env.PHAROS_VERDICT_DEADLINE_MS ?? 800),
  });
  const app = createGatewayApp({
    client,
    tenantId: process.env.PHAROS_TENANT ?? "default",
    agentId: process.env.GATEWAY_AGENT_ID ?? "gateway-agent",
    target: process.env.GATEWAY_TARGET ?? "http://localhost:8080",
    heldRequestStore,
  });
  if (pool) {
    app.addHook("onClose", async () => {
      await pool?.end();
    });
  }
  const port = Number(process.env.GATEWAY_PORT ?? 4100);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(
    `Pharos gateway listening on :${port} → ${process.env.GATEWAY_TARGET ?? "http://localhost:8080"}`,
  );
}

main().catch((err) => {
  console.error("gateway startup error:", err);
  process.exit(1);
});
