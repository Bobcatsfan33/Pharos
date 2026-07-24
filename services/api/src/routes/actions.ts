import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ActionIntentSchema,
  LiabilityContextSchema,
  ActionRecordSchema,
  KmsUnavailableError,
} from "@pharos/core";
import { fingerprintVerdict } from "@pharos/cascade";
import { routeEscalation } from "@pharos/review";
import type { Platform } from "../platform.js";
import { requireAuth } from "../auth.js";

/**
 * The single ingestion surface plus evidence reads.
 *
 * POST /v1/actions submits an agent action and returns two outputs of one transaction:
 * the verdict (Beam) and the sealed, chained ActionRecord (Ledger). Reads of evidence
 * require authentication and are recorded in the hash-chained access audit.
 */
const SubmitBodySchema = z.object({
  tenantId: z.string().min(1),
  action: ActionIntentSchema.extend({
    emittedAt: z.string().datetime().optional(),
  }),
  liability: LiabilityContextSchema,
  /** Optional: bind a stored mandate by id (resolved server-side and sealed into the record). */
  mandateId: z.string().optional(),
  /** Optional idempotency key for the escalation parked on an escalate verdict. */
  idempotencyKey: z.string().optional(),
});

export function registerActionRoutes(app: FastifyInstance, platform: Platform): void {
  app.post("/v1/actions", async (request, reply) => {
    const parsed = SubmitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        data: null,
        error: { code: "invalid_request", issues: parsed.error.issues },
      });
    }
    const body = parsed.data;

    const principal = await requireAuth(platform, request, reply, "actions:write", body.tenantId);
    if (!principal) return reply;

    const action = {
      ...body.action,
      payload: body.action.payload ?? {},
      emittedAt: body.action.emittedAt ?? new Date().toISOString(),
    };

    // Resolve a stored mandate, if referenced, and seal it into the record.
    let liability = body.liability;
    if (body.mandateId) {
      const mandate = await platform.mandates.getActive(body.tenantId, body.mandateId);
      if (!mandate) {
        return reply.status(400).send({
          success: false,
          data: null,
          error: { code: "mandate_not_found", mandateId: body.mandateId },
        });
      }
      liability = { ...liability, mandate };
    }

    const policyArtifacts = await platform.activePolicyArtifacts(body.tenantId);
    const verdict = await platform.cascade.evaluate(
      { tenantId: body.tenantId, action, liability },
      new Date(),
      policyArtifacts,
    );

    let record;
    try {
      record = await platform.store.append({
        tenantId: body.tenantId,
        action,
        verdict,
        liability,
      });
    } catch (err) {
      if (err instanceof KmsUnavailableError) {
        // KMS down ⇒ the record cannot be sealed ⇒ the action cannot be governed. Return 503
        // with a distinct code (no partial/unsealed write happened); the SDK's local fail-mode
        // takes over. We never queue a "sign later" — that would break the transactional invariant.
        return reply.status(503).send({
          success: false,
          data: null,
          error: {
            code: "kms_unavailable",
            message: "signing key service is unavailable; the action was not governed or recorded",
          },
        });
      }
      throw err;
    }

    // Observability: verdict + seal metrics.
    platform.metrics.verdicts.inc({
      decision: verdict.decision,
      tier: String(verdict.tierReached),
    });
    platform.metrics.recordsSealed.inc();
    platform.metrics.verdictLatency.observe(verdict.latency.totalMs);

    // Workflow continuation: an escalate verdict parks the action, routed to a queue.
    let escalation = null;
    if (verdict.decision === "escalate") {
      const routing = routeEscalation({
        actionType: action.type,
        riskScore: verdict.riskScore,
        packs: [...new Set(verdict.ruleCitations.map((c) => c.pack))],
        financialAmount: liability.blastRadius.financialAmount,
        reversibility: liability.blastRadius.reversibility,
      });
      const slaDueAt = new Date(Date.now() + routing.slaMinutes * 60_000).toISOString();
      escalation = await platform.escalations.create({
        tenantId: body.tenantId,
        recordSequence: record.content.sequence,
        idempotencyKey: body.idempotencyKey ?? record.content.id,
        context: { action, liability, verdict, recordId: record.content.id },
        queue: routing.queue,
        priority: routing.priority,
        slaDueAt,
        fourEyes: routing.fourEyes,
      });
      await platform.notifier.fire({
        tenantId: body.tenantId,
        event: "assigned",
        escalationId: escalation.id,
        queue: routing.queue,
      });
      platform.metrics.escalations.inc({ queue: routing.queue });
    }

    return reply.status(201).send({
      success: true,
      data: {
        verdict: record.content.verdict,
        record: ActionRecordSchema.parse(record),
        escalation: escalation ? { id: escalation.id, status: escalation.status } : null,
      },
      error: null,
    });
  });

  app.get<{ Params: { tenantId: string; sequence: string } }>(
    "/v1/records/:tenantId/:sequence",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "records:read", tenantId);
      if (!principal) return reply;

      const sequence = Number(request.params.sequence);
      if (!Number.isInteger(sequence) || sequence < 0) {
        return reply
          .status(400)
          .send({ success: false, data: null, error: { code: "invalid_sequence" } });
      }
      const record = await platform.store.getRecord(tenantId, sequence);
      if (!record) {
        return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
      }
      await platform.accessAudit.record({
        tenantId,
        actor: principal.subject,
        actorKind: principal.kind,
        action: "view",
        resource: `record:${sequence}`,
      });
      return reply.send({ success: true, data: record, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/v1/chain/:tenantId/verify",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "chain:verify", tenantId);
      if (!principal) return reply;

      const report = await platform.integrity.verifyTenant(tenantId);
      await platform.accessAudit.record({
        tenantId,
        actor: principal.subject,
        actorKind: principal.kind,
        action: "verify",
        resource: "chain",
      });
      return reply
        .status(report.ok ? 200 : 409)
        .send({ success: report.ok, data: report, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>("/v1/chain/:tenantId", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:read", tenantId);
    if (!principal) return reply;
    const head = await platform.store.getHead(tenantId);
    const count = await platform.store.count(tenantId);
    return reply.send({ success: true, data: { head, count }, error: null });
  });

  // The published public keyset is verification material — intentionally public.
  app.get("/v1/keyset", async (_request, reply) => {
    const keyset = await platform.signer.publishKeyset();
    return reply.send({ success: true, data: { keys: keyset }, error: null });
  });

  // Judge model registry — versions are cited in verdicts, so they are public.
  app.get("/v1/judges", async (_request, reply) => {
    return reply.send({
      success: true,
      data: { models: platform.registry.listVersions() },
      error: null,
    });
  });

  // Reproducibility: re-evaluate a stored record's inputs and prove the verdict is
  // bit-identical (latency excluded) to the one originally sealed.
  app.get<{ Params: { tenantId: string; sequence: string } }>(
    "/v1/replay/:tenantId/:sequence",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "chain:verify", tenantId);
      if (!principal) return reply;
      const sequence = Number(request.params.sequence);
      const record = await platform.store.getRecord(tenantId, sequence);
      if (!record)
        return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });

      const replayed = await platform.cascade.evaluate(
        { tenantId, action: record.content.action, liability: record.content.liability },
        new Date(record.content.action.emittedAt),
        await platform.activePolicyArtifacts(tenantId),
      );
      const originalFp = fingerprintVerdict(record.content.verdict);
      const replayedFp = fingerprintVerdict(replayed);
      const identical = originalFp === replayedFp;
      return reply.status(identical ? 200 : 409).send({
        success: identical,
        data: {
          identical,
          originalFingerprint: originalFp,
          replayedFingerprint: replayedFp,
          replayed,
        },
        error: null,
      });
    },
  );
}
