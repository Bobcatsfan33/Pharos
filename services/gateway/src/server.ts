import { PharosClient } from "@pharos/sdk";
import { createGatewayApp } from "./gateway.js";

/**
 * Standalone gateway server. Routes an agent's HTTP egress through Pharos with zero code
 * changes in the agent. Configure via env:
 *   PHAROS_API_BASE, PHAROS_API_KEY, PHAROS_TENANT, GATEWAY_AGENT_ID, GATEWAY_TARGET, GATEWAY_PORT
 */
async function main(): Promise<void> {
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
  });
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
