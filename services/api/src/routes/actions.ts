import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ActionIntentSchema,
  LiabilityContextSchema,
  ActionRecordSchema,
} from "@pharos/core";
import type { Platform } from "../platform.js";

/**
 * The single ingestion surface.
 *
 * POST /v1/actions submits an agent action and returns two outputs of one
 * transaction: the verdict (Beam) and the sealed, chained ActionRecord (Ledger).
 * The action cannot be governed without being recorded.
 */
const SubmitBodySchema = z.object({
  tenantId: z.string().min(1),
  action: ActionIntentSchema.extend({
    // Allow clients to omit emittedAt; the platform stamps it.
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
    const action = {
      ...body.action,
      payload: body.action.payload ?? {},
      emittedAt: body.action.emittedAt ?? new Date().toISOString(),
    };

    const verdict = platform.engine.evaluate(
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
      data: {
        verdict: record.content.verdict,
        record: ActionRecordSchema.parse(record),
      },
      error: null,
    });
  });

  app.get<{ Params: { tenantId: string; sequence: string } }>(
    "/v1/records/:tenantId/:sequence",
    async (request, reply) => {
      const sequence = Number(request.params.sequence);
      if (!Number.isInteger(sequence) || sequence < 0) {
        return reply.status(400).send({ success: false, data: null, error: { code: "invalid_sequence" } });
      }
      const record = await platform.store.getRecord(request.params.tenantId, sequence);
      if (!record) {
        return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
      }
      return reply.send({ success: true, data: record, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/v1/chain/:tenantId/verify",
    async (request, reply) => {
      const report = await platform.integrity.verifyTenant(request.params.tenantId);
      return reply.status(report.ok ? 200 : 409).send({ success: report.ok, data: report, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>("/v1/chain/:tenantId", async (request, reply) => {
    const head = await platform.store.getHead(request.params.tenantId);
    const count = await platform.store.count(request.params.tenantId);
    return reply.send({ success: true, data: { head, count }, error: null });
  });

  app.get("/v1/keyset", async (_request, reply) => {
    const keyset = await platform.signer.publishKeyset();
    return reply.send({ success: true, data: { keys: keyset }, error: null });
  });
}
