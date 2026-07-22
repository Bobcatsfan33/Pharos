import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ActionRecord } from "@pharos/core";
import {
  wilsonInterval,
  computeRiskProfile,
  evaluateReadiness,
  buildUnderwriterFeed,
  type RecordSummary,
} from "@pharos/assurance";
import type { Platform } from "../platform.js";
import { requireAuth } from "../auth.js";

/**
 * Beam Count routes: continuous assurance (Wilson-score verified accuracy), risk profile v2,
 * the readiness gate (which blocks external release on a failing check unless an owner grants
 * an exception), and the versioned, consent-gated underwriter feed.
 */
function toSummary(r: ActionRecord): RecordSummary {
  return {
    decision: r.content.verdict.decision,
    oversightMode: r.content.liability.oversightMode,
    reversibility: r.content.liability.blastRadius.reversibility,
    financialAmount: r.content.liability.blastRadius.financialAmount,
    failMode: r.content.verdict.failMode,
    mandatePresent: r.content.liability.mandate !== null,
  };
}

function disagreementRateFrom(resolved: Array<{ context: unknown; resolution: unknown }>): number {
  if (resolved.length === 0) return 0;
  let dis = 0;
  for (const e of resolved) {
    const risk = (e.context as { verdict?: { riskScore?: number } }).verdict?.riskScore ?? 0;
    const decision = (e.resolution as { decision?: string } | null)?.decision;
    const machineStop = risk >= 0.5;
    const humanStop = decision === "reject";
    if (machineStop !== humanStop) dis += 1;
  }
  return dis / resolved.length;
}

export function registerAssuranceRoutes(app: FastifyInstance, platform: Platform): void {
  // Sample unreviewed verdicts into the audit queue.
  app.post<{ Params: { tenantId: string }; Body: { count?: number } }>(
    "/v1/tenants/:tenantId/assurance/sample",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "reviews:act", tenantId);
      if (!principal) return reply;
      const chain = await platform.store.getChain(tenantId);
      const candidates = chain.map((r) => ({
        recordSequence: r.content.sequence,
        pack: r.content.verdict.ruleCitations[0]?.pack ?? "core",
        decision: r.content.verdict.decision,
      }));
      const added = await platform.assurance.sample(tenantId, candidates);
      return reply.send({ success: true, data: { sampled: added }, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/assurance/pending",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "reviews:read", tenantId);
      if (!principal) return reply;
      return reply.send({
        success: true,
        data: { pending: await platform.assurance.listPending(tenantId) },
        error: null,
      });
    },
  );

  app.post<{ Params: { tenantId: string; id: string }; Body: { upheld: boolean } }>(
    "/v1/tenants/:tenantId/assurance/:id/audit",
    async (request, reply) => {
      const { tenantId, id } = request.params;
      const principal = await requireAuth(platform, request, reply, "reviews:act", tenantId);
      if (!principal) return reply;
      const parsed = z.object({ upheld: z.boolean() }).safeParse(request.body);
      if (!parsed.success)
        return reply
          .status(400)
          .send({ success: false, data: null, error: { code: "invalid_request" } });
      await platform.assurance.recordAudit(tenantId, id, parsed.data.upheld, principal.subject);
      return reply.send({ success: true, data: { id, upheld: parsed.data.upheld }, error: null });
    },
  );

  // Measured assurance: Wilson-score lower bound overall and per pack.
  app.get<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/assurance",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "audit:read", tenantId);
      if (!principal) return reply;
      const overall = await platform.assurance.stats(tenantId);
      const byPackStats = await platform.assurance.statsByPack(tenantId);
      const interval = wilsonInterval(overall.upheld, overall.total);
      const byPack: Record<string, unknown> = {};
      for (const [pack, s] of Object.entries(byPackStats))
        byPack[pack] = wilsonInterval(s.upheld, s.total);
      return reply.send({
        success: true,
        data: { verifiedAccuracy: interval, byPack, samples: overall.total },
        error: null,
      });
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/risk-profile",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "audit:read", tenantId);
      if (!principal) return reply;
      const chain = await platform.store.getChain(tenantId);
      const overall = await platform.assurance.stats(tenantId);
      const resolved = await platform.escalations.listResolved(tenantId);
      const profile = computeRiskProfile(
        chain.map(toSummary),
        wilsonInterval(overall.upheld, overall.total),
        disagreementRateFrom(resolved),
      );
      return reply.send({ success: true, data: { riskProfile: profile }, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/readiness",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "audit:read", tenantId);
      if (!principal) return reply;
      const result = await evaluateReadinessForTenant(platform, tenantId);
      return reply.send({ success: true, data: { readiness: result }, error: null });
    },
  );

  app.post<{ Params: { tenantId: string }; Body: { checkId?: string; reason?: string } }>(
    "/v1/tenants/:tenantId/readiness/exceptions",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "tenants:manage", tenantId);
      if (!principal) return reply;
      const checkId = request.body?.checkId;
      if (!checkId)
        return reply
          .status(400)
          .send({ success: false, data: null, error: { code: "missing_check_id" } });
      await platform.assurance.grantException(
        tenantId,
        checkId,
        principal.subject,
        request.body?.reason,
      );
      return reply.send({
        success: true,
        data: { checkId, owner: principal.subject },
        error: null,
      });
    },
  );

  // Underwriter feed — an external release; gated by the readiness gate.
  app.get<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/underwriter-feed",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "audit:read", tenantId);
      if (!principal) return reply;
      const readiness = await evaluateReadinessForTenant(platform, tenantId);
      if (readiness.blocked) {
        return reply
          .status(409)
          .send({ success: false, data: { readiness }, error: { code: "readiness_gate_blocked" } });
      }
      const chain = await platform.store.getChain(tenantId);
      const overall = await platform.assurance.stats(tenantId);
      const resolved = await platform.escalations.listResolved(tenantId);
      const interval = wilsonInterval(overall.upheld, overall.total);
      const profile = computeRiskProfile(
        chain.map(toSummary),
        interval,
        disagreementRateFrom(resolved),
      );
      const feed = buildUnderwriterFeed(tenantId, profile, interval, new Date().toISOString());
      await platform.accessAudit.record({
        tenantId,
        actor: principal.subject,
        actorKind: principal.kind,
        action: "export",
        resource: "underwriter-feed",
      });
      return reply.send({ success: true, data: { feed }, error: null });
    },
  );
}

async function evaluateReadinessForTenant(platform: Platform, tenantId: string) {
  const chain = await platform.store.getChain(tenantId);
  const chainReport = await platform.integrity.verifyTenant(tenantId);
  const exceptions = await platform.assurance.exceptions(tenantId);
  return evaluateReadiness(chain.map(toSummary), chainReport.ok, undefined, exceptions);
}
