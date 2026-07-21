import type { FastifyInstance } from "fastify";
import { summarize, draftRuleCandidates, type ReviewRecord, type ResolvedItem } from "@pharos/review";
import type { Escalation } from "@pharos/storage";
import type { Platform } from "../platform.js";
import { requireAuth } from "../auth.js";

/**
 * Review-operations routes: queues, assignment, analytics, the disagreement dashboard, and
 * the notification audit. The reviewer workspace (console) reads these.
 */
function toReviewRecord(e: Escalation): ReviewRecord {
  const ctx = e.context as { verdict?: { riskScore?: number; ruleCitations?: Array<{ ruleId: string; pack: string }> } };
  const citations = ctx.verdict?.ruleCitations ?? [];
  const resolution = e.resolution as { decision?: "approve" | "modify" | "reject" } | null;
  return {
    escalationId: e.id,
    queue: e.queue,
    riskScore: ctx.verdict?.riskScore ?? 0,
    citedRules: citations.map((c) => c.ruleId),
    dominantPack: citations[0]?.pack ?? null,
    humanDecision: resolution?.decision ?? "approve",
    createdAtMs: Date.parse(e.createdAt),
    resolvedAtMs: e.resolvedAt ? Date.parse(e.resolvedAt) : Date.parse(e.createdAt),
    slaDueAtMs: e.slaDueAt ? Date.parse(e.slaDueAt) : Number.MAX_SAFE_INTEGER,
    resolvedBy: e.resolvedBy ?? "unknown",
  };
}

export function registerReviewRoutes(app: FastifyInstance, platform: Platform): void {
  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/queues", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "reviews:read", tenantId);
    if (!principal) return reply;
    const depths = await platform.escalations.queueDepths(tenantId);
    return reply.send({ success: true, data: { queues: depths }, error: null });
  });

  app.get<{ Params: { tenantId: string; queue: string } }>(
    "/v1/tenants/:tenantId/queues/:queue",
    async (request, reply) => {
      const { tenantId, queue } = request.params;
      const principal = await requireAuth(platform, request, reply, "reviews:read", tenantId);
      if (!principal) return reply;
      const escalations = await platform.escalations.listByQueue(tenantId, queue);
      return reply.send({ success: true, data: { queue, escalations }, error: null });
    },
  );

  app.post<{ Params: { tenantId: string; id: string }; Body: { reviewer?: string } }>(
    "/v1/tenants/:tenantId/escalations/:id/assign",
    async (request, reply) => {
      const { tenantId, id } = request.params;
      const principal = await requireAuth(platform, request, reply, "reviews:act", tenantId);
      if (!principal) return reply;
      const reviewer = request.body?.reviewer ?? principal.subject;
      const assigned = await platform.escalations.assign(tenantId, id, reviewer);
      if (!assigned) return reply.status(409).send({ success: false, data: null, error: { code: "not_pending" } });
      return reply.send({ success: true, data: { escalation: assigned }, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/review/analytics", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "reviews:read", tenantId);
    if (!principal) return reply;
    const resolved = await platform.escalations.listResolved(tenantId);
    const records = resolved.map(toReviewRecord);
    const depths = await platform.escalations.queueDepths(tenantId);
    return reply.send({ success: true, data: { ...summarize(records), queueDepth: depths }, error: null });
  });

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/review/disagreements", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "reviews:read", tenantId);
    if (!principal) return reply;
    const resolved = await platform.escalations.listResolved(tenantId);
    const items: ResolvedItem[] = resolved.map(toReviewRecord);
    return reply.send({ success: true, data: { ruleCandidates: draftRuleCandidates(items) }, error: null });
  });

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/review/notifications", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "reviews:read", tenantId);
    if (!principal) return reply;
    const notifications = await platform.notifier.list(tenantId);
    return reply.send({ success: true, data: { notifications }, error: null });
  });
}
