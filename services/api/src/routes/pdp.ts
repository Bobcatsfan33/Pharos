import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PDP_SPEC_VERSION, type PdpResponse } from "@pharos/pdp-spec";
import { authenticate } from "../auth.js";
import { authorize, AuthorizationError } from "@pharos/identity";
import type { Platform } from "../platform.js";

/**
 * The public Policy Decision Point endpoint implementing the open PDP contract v1.0.
 *
 * POST /v1/pdp  { action, liability, deadlineMs? }  ->  PdpResponse (+ evidenceBinding)
 *
 * Tenant is taken from the API key. Unlike the conformance reference, this endpoint seals a
 * signed evidence record and returns the binding, so the verdict is provable.
 */
const PdpRequestSchema = z.object({
  action: z.object({ type: z.string().min(1), agentId: z.string().min(1), payload: z.record(z.string(), z.unknown()).optional() }),
  liability: z.object({
    mandate: z.object({ id: z.string(), limits: z.record(z.string(), z.unknown()).optional() }).nullable().optional(),
    oversightMode: z.enum(["autonomous", "human_in_loop", "human_on_loop"]),
    blastRadius: z.object({ financialAmount: z.number().optional(), currency: z.string().optional(), reversibility: z.enum(["reversible", "irreversible"]) }),
  }),
  deadlineMs: z.number().int().optional(),
});

export function registerPdpRoutes(app: FastifyInstance, platform: Platform): void {
  app.get("/v1/pdp/spec", async (_request, reply) => {
    return reply.send({ success: true, data: { specVersion: PDP_SPEC_VERSION }, error: null });
  });

  app.post("/v1/pdp", async (request, reply) => {
    // Authenticate and authorize (actions:write); tenant comes from the credential.
    let principal;
    try {
      principal = await authenticate(platform, request);
      authorize(principal, principal.tenantId, "actions:write");
    } catch (err) {
      const code = err instanceof AuthorizationError ? err.code : "unauthenticated";
      return reply.status(code === "forbidden" ? 403 : 401).send({ success: false, data: null, error: { code } });
    }
    const tenantId = principal.tenantId;

    const parsed = PdpRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, data: null, error: { code: "invalid_request", issues: parsed.error.issues } });
    const req = parsed.data;

    const action = { type: req.action.type, agentId: req.action.agentId, payload: req.action.payload ?? {}, emittedAt: new Date().toISOString() };
    const liability = {
      mandate: req.liability.mandate ? { id: req.liability.mandate.id, scope: "", limits: req.liability.mandate.limits ?? {}, grantor: "", expiresAt: null, version: "1" } : null,
      oversightMode: req.liability.oversightMode,
      blastRadius: { financialAmount: req.liability.blastRadius.financialAmount ?? 0, currency: req.liability.blastRadius.currency ?? "USD", reversibility: req.liability.blastRadius.reversibility },
      modelMetadata: null,
    };

    const verdict = await platform.cascade.evaluate({ tenantId, action, liability }, new Date(), await platform.activePolicyArtifacts(tenantId));
    const record = await platform.store.append({ tenantId, action, verdict, liability });
    platform.metrics.verdicts.inc({ decision: verdict.decision, tier: String(verdict.tierReached) });
    platform.metrics.recordsSealed.inc();

    const response: PdpResponse = {
      specVersion: PDP_SPEC_VERSION,
      decision: verdict.decision,
      tierReached: verdict.tierReached,
      riskScore: verdict.riskScore,
      ruleCitations: verdict.ruleCitations,
      failMode: verdict.failMode,
      judgeVersion: verdict.judgeVersion,
      latency: { totalMs: verdict.latency.totalMs, deadlineMs: req.deadlineMs ?? verdict.latency.deadlineMs, deadlineBreached: verdict.latency.deadlineBreached },
      evidenceBinding: { algorithm: "ed25519", contentHash: record.seal.contentHash, keyId: record.seal.keyId, signature: record.seal.signature },
    };
    return reply.send({ success: true, data: response, error: null });
  });
}
