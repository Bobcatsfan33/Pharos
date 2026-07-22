import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LiabilityContext, VerdictDecision } from "@pharos/core";
import type { Platform } from "../platform.js";
import { requireAuth } from "../auth.js";

/**
 * Workflow continuation routes.
 *
 *   GET    /v1/tenants/:t/escalations            list pending (reviews:read)
 *   GET    /v1/tenants/:t/escalations/:id        fetch one    (reviews:read)
 *   POST   /v1/tenants/:t/escalations/:id/resolve   human verdict, sealed as evidence (reviews:act)
 *   POST   /v1/tenants/:t/escalations/:id/claim      agent claims resume, exactly-once (actions:write)
 */
const ResolveSchema = z.object({
  decision: z.enum(["approve", "modify", "reject"]),
  rationale: z.string().min(1),
  modifiedAction: z.record(z.string(), z.unknown()).optional(),
});

const DECISION_TO_VERDICT: Record<"approve" | "modify" | "reject", VerdictDecision> = {
  approve: "allow",
  modify: "modify",
  reject: "block",
};

export function registerEscalationRoutes(app: FastifyInstance, platform: Platform): void {
  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/escalations", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "reviews:read", tenantId);
    if (!principal) return reply;
    const escalations = await platform.escalations.listPending(tenantId);
    return reply.send({ success: true, data: { escalations }, error: null });
  });

  app.get<{ Params: { tenantId: string; id: string } }>(
    "/v1/tenants/:tenantId/escalations/:id",
    async (request, reply) => {
      const { tenantId, id } = request.params;
      const principal = await requireAuth(platform, request, reply, "reviews:read", tenantId);
      if (!principal) return reply;
      const escalation = await platform.escalations.get(tenantId, id);
      if (!escalation) return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
      return reply.send({ success: true, data: { escalation }, error: null });
    },
  );

  app.post<{ Params: { tenantId: string; id: string } }>(
    "/v1/tenants/:tenantId/escalations/:id/resolve",
    async (request, reply) => {
      const { tenantId, id } = request.params;
      const principal = await requireAuth(platform, request, reply, "reviews:act", tenantId);
      if (!principal) return reply;
      const parsed = ResolveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, data: null, error: { code: "invalid_request", issues: parsed.error.issues } });
      }

      const resolved = await platform.escalations.resolve(tenantId, id, {
        decision: parsed.data.decision,
        rationale: parsed.data.rationale,
        resolvedBy: principal.subject,
        modifiedAction: parsed.data.modifiedAction,
      });
      if (!resolved) {
        return reply.status(409).send({ success: false, data: null, error: { code: "not_pending" } });
      }

      // Seal the human verdict as evidence, linking reviewer identity, rationale, and the
      // machine context it overrode.
      const ctx = resolved.context as { liability?: LiabilityContext; recordId?: string };
      const liability: LiabilityContext = ctx.liability ?? {
        mandate: null,
        oversightMode: "human_in_loop",
        blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
        modelMetadata: null,
      };
      const humanRecord = await platform.store.append({
        tenantId,
        action: {
          type: "review.verdict",
          agentId: principal.subject,
          payload: {
            escalationId: id,
            overrodeRecordId: ctx.recordId ?? null,
            decision: parsed.data.decision,
            rationale: parsed.data.rationale,
          },
          emittedAt: new Date().toISOString(),
        },
        verdict: {
          decision: DECISION_TO_VERDICT[parsed.data.decision],
          tierReached: "human",
          ruleCitations: [
            { ruleId: "human-review", pack: "review", clause: "tier.human", description: parsed.data.rationale },
          ],
          riskScore: 0,
          failMode: null,
          judgeVersion: null,
          latency: { totalMs: 0, perTier: {}, deadlineMs: platform.config.api.verdictDeadlineMs, deadlineBreached: false },
        },
        liability,
      });

      return reply.send({
        success: true,
        data: { escalation: resolved, humanVerdictSequence: humanRecord.content.sequence },
        error: null,
      });
    },
  );

  app.post<{ Params: { tenantId: string; id: string } }>(
    "/v1/tenants/:tenantId/escalations/:id/claim",
    async (request, reply) => {
      const { tenantId, id } = request.params;
      const principal = await requireAuth(platform, request, reply, "actions:write", tenantId);
      if (!principal) return reply;
      const escalation = await platform.escalations.get(tenantId, id);
      if (!escalation) return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
      if (escalation.status === "pending") {
        return reply.send({ success: true, data: { claimed: false, status: "pending", escalation }, error: null });
      }
      if (escalation.status === "rejected") {
        return reply.send({ success: true, data: { claimed: false, status: "rejected", escalation }, error: null });
      }
      // Atomic claim: exactly one caller wins the right to resume the side effect.
      const claimed = await platform.escalations.claimResume(tenantId, id);
      return reply.send({
        success: true,
        data: { claimed: claimed !== null, status: escalation.status, resolution: escalation.resolution, escalation: claimed ?? escalation },
        error: null,
      });
    },
  );
}
