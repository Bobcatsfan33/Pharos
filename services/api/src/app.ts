import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Platform } from "./platform.js";
import { registerActionRoutes } from "./routes/actions.js";

/**
 * Build the Fastify app over a wired platform. Kept separate from the server
 * entrypoint so tests can drive it via inject() without binding a port.
 */
export async function buildApp(platform: Platform): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  // Sprint 0: permissive CORS for local development; Sprint 1 (Gatehouse) locks this
  // to configured origins along with auth, RBAC, and rate limiting.
  await app.register(cors, { origin: true });

  app.get("/healthz", async () => {
    const redisOk = await platform.cache.ping().catch(() => false);
    return { status: "ok", env: platform.config.env, redis: redisOk };
  });

  registerActionRoutes(app, platform);

  return app;
}
