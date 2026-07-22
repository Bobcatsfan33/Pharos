import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Platform } from "../platform.js";
import { requireAuth } from "../auth.js";

/**
 * Mandate API — create, version, and bind mandates programmatically. A mandate grants an
 * agent bounded authority; verdicts evaluate it as a Tier-1 input and seal it into records.
 */
const CreateMandateSchema = z.object({
  mandateId: z.string().min(1),
  scope: z.string().min(1),
  limits: z.record(z.string(), z.unknown()).optional(),
  grantor: z.string().min(1),
  expiresAt: z.string().datetime().nullable().optional(),
});

export function registerMandateRoutes(app: FastifyInstance, platform: Platform): void {
  app.post<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/mandates", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "policies:write", tenantId);
    if (!principal) return reply;
    const parsed = CreateMandateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, data: null, error: { code: "invalid_request", issues: parsed.error.issues } });
    }
    const mandate = await platform.mandates.create({ tenantId, ...parsed.data });
    return reply.status(201).send({ success: true, data: { mandate }, error: null });
  });

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/mandates", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "policies:read", tenantId);
    if (!principal) return reply;
    const mandates = await platform.mandates.list(tenantId);
    return reply.send({ success: true, data: { mandates }, error: null });
  });

  app.post<{ Params: { tenantId: string; mandateId: string } }>(
    "/v1/tenants/:tenantId/mandates/:mandateId/revoke",
    async (request, reply) => {
      const { tenantId, mandateId } = request.params;
      const principal = await requireAuth(platform, request, reply, "policies:write", tenantId);
      if (!principal) return reply;
      await platform.mandates.revoke(tenantId, mandateId);
      return reply.send({ success: true, data: { mandateId, status: "revoked" }, error: null });
    },
  );
}
