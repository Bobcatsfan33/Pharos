import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { compilePolicy, dryRun, decideWith, type EvalContext, type PolicyArtifact, SHIPPED_PACKS } from "@pharos/policy";
import { actionText } from "@pharos/cascade";
import type { VerdictRequest } from "@pharos/core";
import type { Platform } from "../platform.js";
import { requireAuth } from "../auth.js";

/**
 * Policy lifecycle routes: compile NL → candidate rules; dry-run against historical traffic
 * (the impact dashboard); shadow mode with divergence; activate (only from shadow, enforcing
 * dry-run-before-enforce); and one-click rollback.
 */
const CompileSchema = z.object({ name: z.string().min(1), text: z.string().min(1) });

const JUDGE_PACKS = ["finra-promissory", "phi-in-context", "funds-movement-intent"];

export function registerPolicyRoutes(app: FastifyInstance, platform: Platform): void {
  // Build EvalContexts from the tenant's historical traffic (recomputing judge probabilities).
  async function historicalContexts(tenantId: string, window: number): Promise<EvalContext[]> {
    const head = await platform.store.getHead(tenantId);
    if (!head) return [];
    const from = Math.max(0, head.sequence - window + 1);
    const range = await platform.store.getRange(tenantId, from, head.sequence);
    return range.map(({ record }) => {
      const request: VerdictRequest = { tenantId, action: record.content.action, liability: record.content.liability };
      const text = actionText(request);
      const judgeProbabilities: Record<string, number> = {};
      for (const pack of JUDGE_PACKS) if (platform.registry.has(pack)) judgeProbabilities[pack] = platform.registry.judge(pack, text).probability;
      return { request, judgeProbabilities };
    });
  }

  app.post<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/policies/compile", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "policies:write", tenantId);
    if (!principal) return reply;
    const parsed = CompileSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, data: null, error: { code: "invalid_request", issues: parsed.error.issues } });

    const compiled = compilePolicy(parsed.data.name, "1", parsed.data.name, parsed.data.text);
    const artifact: PolicyArtifact = { packId: parsed.data.name, version: "1", title: parsed.data.name, rules: compiled.rules };
    const policy = await platform.policyStore.createDraft({ tenantId, name: parsed.data.name, artifact, sourceText: parsed.data.text });
    return reply.status(201).send({ success: true, data: { policy, warnings: compiled.warnings, unparsed: compiled.unparsed }, error: null });
  });

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/policies", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "policies:read", tenantId);
    if (!principal) return reply;
    return reply.send({ success: true, data: { policies: await platform.policyStore.list(tenantId), shippedPacks: Object.values(SHIPPED_PACKS).map((p) => ({ packId: p.packId, version: p.version, rules: p.rules.length })) }, error: null });
  });

  // Dry-run / impact dashboard.
  app.post<{ Params: { tenantId: string; id: string }; Body: { window?: number } }>(
    "/v1/tenants/:tenantId/policies/:id/dry-run",
    async (request, reply) => {
      const { tenantId, id } = request.params;
      const principal = await requireAuth(platform, request, reply, "policies:read", tenantId);
      if (!principal) return reply;
      const policy = await platform.policyStore.get(tenantId, id);
      if (!policy) return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
      const contexts = await historicalContexts(tenantId, request.body?.window ?? 100_000);
      const result = dryRun(policy.artifact as PolicyArtifact, contexts);
      return reply.send({ success: true, data: { impact: result }, error: null });
    },
  );

  app.post<{ Params: { tenantId: string; id: string } }>("/v1/tenants/:tenantId/policies/:id/shadow", async (request, reply) => {
    const { tenantId, id } = request.params;
    const principal = await requireAuth(platform, request, reply, "policies:write", tenantId);
    if (!principal) return reply;
    const policy = await platform.policyStore.setStatus(tenantId, id, "shadow");
    if (!policy) return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
    return reply.send({ success: true, data: { policy }, error: null });
  });

  // Divergence: shadow candidate decisions vs the active policy decisions over a window.
  app.post<{ Params: { tenantId: string; id: string }; Body: { window?: number } }>(
    "/v1/tenants/:tenantId/policies/:id/divergence",
    async (request, reply) => {
      const { tenantId, id } = request.params;
      const principal = await requireAuth(platform, request, reply, "policies:read", tenantId);
      if (!principal) return reply;
      const candidate = await platform.policyStore.get(tenantId, id);
      if (!candidate) return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
      const active = await platform.activePolicyArtifacts(tenantId);
      const contexts = await historicalContexts(tenantId, request.body?.window ?? 100_000);
      let diverged = 0;
      for (const ctx of contexts) {
        const activeDecision = mostSevereAcross(active, ctx);
        const candDecision = decideWith(candidate.artifact as PolicyArtifact, ctx);
        if (worse(candDecision, activeDecision) !== activeDecision) diverged += 1;
      }
      return reply.send({ success: true, data: { total: contexts.length, diverged }, error: null });
    },
  );

  app.post<{ Params: { tenantId: string; id: string } }>("/v1/tenants/:tenantId/policies/:id/activate", async (request, reply) => {
    const { tenantId, id } = request.params;
    const principal = await requireAuth(platform, request, reply, "policies:write", tenantId);
    if (!principal) return reply;
    const policy = await platform.policyStore.get(tenantId, id);
    if (!policy) return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
    // Enforce dry-run-before-enforce: a policy must pass through shadow before activation.
    if (policy.status !== "shadow") {
      return reply.status(409).send({ success: false, data: null, error: { code: "must_shadow_first", message: "Promote to shadow and review divergence before activating." } });
    }
    const activated = await platform.policyStore.activate(tenantId, id);
    return reply.send({ success: true, data: { policy: activated }, error: null });
  });

  app.post<{ Params: { tenantId: string; name: string } }>("/v1/tenants/:tenantId/policies/:name/rollback", async (request, reply) => {
    const { tenantId, name } = request.params;
    const principal = await requireAuth(platform, request, reply, "policies:write", tenantId);
    if (!principal) return reply;
    const result = await platform.policyStore.rollback(tenantId, name);
    return reply.send({ success: true, data: result, error: null });
  });
}

import { evaluateArtifact, type PolicyArtifact as PA } from "@pharos/policy";
import type { VerdictDecision } from "@pharos/core";

const SEVERITY: Record<VerdictDecision, number> = { allow: 0, modify: 1, escalate: 2, block: 3 };
function worse(a: VerdictDecision, b: VerdictDecision): VerdictDecision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}
function mostSevereAcross(artifacts: PA[], ctx: EvalContext): VerdictDecision {
  let d: VerdictDecision = "allow";
  for (const artifact of artifacts) for (const m of evaluateArtifact(artifact, ctx)) d = worse(d, m.decision);
  return d;
}
