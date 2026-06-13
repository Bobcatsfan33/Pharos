import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ActionIntentSchema,
  LiabilityContextSchema,
  ActionRecordSchema,
} from "@pharos/core";
import { fingerprintVerdict } from "@pharos/cascade";
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

    const verdict = await platform.cascade.evaluate(
      { tenantId: body.tenantId, action, liability: body.liability },
      new Date(),
    );

    const record = await platform.store.append({
      tenantId: body.tenantId,
      action,
      verdict,
      liability: body.liability,
    });

    return reply.status(201).send({
      success: true,
      data: { verdict: record.content.verdict, record: ActionRecordSchema.parse(record) },
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
        return reply.status(400).send({ success: false, data: null, error: { code: "invalid_sequence" } });
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

  app.get<{ Params: { tenantId: string } }>("/v1/chain/:tenantId/verify", async (request, reply) => {
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
    return reply.status(report.ok ? 200 : 409).send({ success: report.ok, data: report, error: null });
  });

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
    return reply.send({ success: true, data: { models: platform.registry.listVersions() }, error: null });
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
      if (!record) return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });

      const replayed = await platform.cascade.evaluate(
        { tenantId, action: record.content.action, liability: record.content.liability },
        new Date(record.content.action.emittedAt),
      );
      const originalFp = fingerprintVerdict(record.content.verdict);
      const replayedFp = fingerprintVerdict(replayed);
      const identical = originalFp === replayedFp;
      return reply.status(identical ? 200 : 409).send({
        success: identical,
        data: { identical, originalFingerprint: originalFp, replayedFingerprint: replayedFp, replayed },
        error: null,
      });
    },
  );
}
