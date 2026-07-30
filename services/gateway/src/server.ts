import { PharosClient } from "@getpharos/sdk";
import {
  PostgresHeldRequestStore,
  createPool,
  heldRequestKeyringFromMasters,
  runMigrations,
  type HeldRequestStore,
  type Pool,
} from "@pharos/storage";
import { loadGatewayDurabilityConfig, loadGatewayServerConfig } from "./config.js";
import { createGatewayApp } from "./gateway.js";

/**
 * Standalone gateway server. Routes an agent's HTTP egress through Pharos with zero code
 * changes in the agent. Configure via env:
 *   PHAROS_API_BASE, PHAROS_API_KEY, PHAROS_TENANT, GATEWAY_AGENT_ID, GATEWAY_TARGET, GATEWAY_PORT,
 *   PHAROS_PG_URL, PHAROS_GATEWAY_HOLD_ACTIVE_KEY_ID, PHAROS_GATEWAY_HOLD_KEYS_B64
 */
async function main(): Promise<void> {
  const config = loadGatewayServerConfig(process.env);
  let heldRequestStore: HeldRequestStore | undefined;
  let pool: Pool | undefined;
  const durability = loadGatewayDurabilityConfig(process.env);
  if (durability) {
    pool = createPool(durability.pgUrl);
    await runMigrations(pool);
    heldRequestStore = new PostgresHeldRequestStore(
      pool,
      heldRequestKeyringFromMasters(durability.activeKeyId, durability.masterKeys),
    );
  }

  const client = new PharosClient({
    baseUrl: config.apiBase,
    apiKey: config.apiKey,
    deadlineMs: config.verdictDeadlineMs,
  });
  const app = createGatewayApp({
    client,
    tenantId: config.tenantId,
    agentId: config.agentId,
    target: config.target,
    heldRequestStore,
    readinessCheck: pool ? async () => void (await pool.query("SELECT 1")) : undefined,
  });
  if (pool) {
    app.addHook("onClose", async () => {
      await pool?.end();
    });
  }
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Pharos gateway received ${signal}; draining`);
    const forcedExit = setTimeout(() => process.exit(1), 25_000);
    forcedExit.unref();
    await app.close();
    clearTimeout(forcedExit);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`Pharos gateway listening on :${config.port} → ${config.target}`);
}

main().catch((err) => {
  console.error("gateway startup error:", err);
  process.exit(1);
});
