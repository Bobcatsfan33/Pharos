/**
 * Online re-encryption for one tenant's pending gateway continuations.
 *
 * Deploy the expanded key ring first, switch its active id, then run:
 *   pnpm gateway:rotate-held-keys -- <tenant-id>
 *
 * The job takes row locks in bounded batches and skips deliveries in progress. A non-zero
 * exit after re-encryption means old-key rows remain (normally an active/expired lease);
 * rerun after the delivery lease window.
 */
import {
  PostgresHeldRequestStore,
  createPool,
  heldRequestKeyringFromMasters,
  runMigrations,
} from "../packages/storage/src/index.js";
import { loadGatewayDurabilityConfig } from "../services/gateway/src/config.js";

async function main(): Promise<void> {
  const tenantId = process.argv
    .slice(2)
    .find((argument) => argument !== "--")
    ?.trim();
  if (!tenantId) {
    throw new Error("usage: pnpm gateway:rotate-held-keys -- <tenant-id>");
  }
  const config = loadGatewayDurabilityConfig(process.env);
  if (!config) {
    throw new Error("gateway durable-store configuration is required");
  }
  if (config.activeKeyId === "legacy") {
    throw new Error("configure a versioned key ring with a non-legacy active key first");
  }

  const pool = createPool(config.pgUrl);
  try {
    await runMigrations(pool);
    const store = new PostgresHeldRequestStore(
      pool,
      heldRequestKeyringFromMasters(config.activeKeyId, config.masterKeys),
    );
    console.log(
      JSON.stringify({
        event: "gateway_key_rotation_started",
        tenantId,
        activeKeyId: config.activeKeyId,
        usage: await store.keyUsage(tenantId),
      }),
    );
    let total = 0;
    for (;;) {
      const updated = await store.reencryptPending(tenantId, 100);
      total += updated;
      if (updated === 0) break;
    }
    const usage = await store.keyUsage(tenantId);
    const remaining = usage.filter((entry) => entry.keyId !== config.activeKeyId);
    console.log(
      JSON.stringify({
        event: "gateway_key_rotation_finished",
        tenantId,
        activeKeyId: config.activeKeyId,
        reencrypted: total,
        usage,
      }),
    );
    if (remaining.length > 0) {
      console.error(
        "old-key rows remain; wait for active delivery leases to finish or expire, then rerun",
      );
      process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("gateway held-request key rotation failed:", (error as Error).message);
  process.exit(1);
});
