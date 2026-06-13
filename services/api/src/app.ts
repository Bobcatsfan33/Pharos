import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { Platform } from "./platform.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerMandateRoutes } from "./routes/mandates.js";
import { registerEscalationRoutes } from "./routes/escalations.js";
import { registerReviewRoutes } from "./routes/review.js";
import { registerSealRoutes } from "./routes/seal.js";
import { registerPolicyRoutes } from "./routes/policies.js";
import { registerAssuranceRoutes } from "./routes/assurance.js";
import { registerBillingRoutes } from "./routes/billing.js";

/**
 * Build the Fastify app over a wired platform. Kept separate from the server
 * entrypoint so tests can drive it via inject() without binding a port.
 */
export async function buildApp(platform: Platform): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  // CORS is locked to configured origins (deny-by-default). With no origins configured,
  // cross-origin browser requests are rejected; server-to-server (SDK/gateway) is
  // unaffected since it does not send an Origin header.
  const allowed = platform.config.api.allowedOrigins;
  await app.register(cors, {
    origin: allowed.length > 0 ? allowed : false,
    credentials: true,
  });

  app.get("/healthz", async () => {
    const redisOk = await platform.cache.ping().catch(() => false);
    return { status: "ok", env: platform.config.env, redis: redisOk };
  });

  // Prometheus metrics exposition (scraped by the observability stack).
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return platform.metrics.render();
  });

  registerActionRoutes(app, platform);
  registerAdminRoutes(app, platform);
  registerMandateRoutes(app, platform);
  registerEscalationRoutes(app, platform);
  registerReviewRoutes(app, platform);
  registerSealRoutes(app, platform);
  registerPolicyRoutes(app, platform);
  registerAssuranceRoutes(app, platform);
  registerBillingRoutes(app, platform);

  return app;
}
