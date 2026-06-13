import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assembleClaimsPack,
  verifyClaimsPack,
  createTimestamp,
  generateRegulatoryExport,
  type Audience,
  type RegulatoryFormat,
} from "@pharos/evidence";
import type { Platform } from "../platform.js";
import { requireAuth } from "../auth.js";

/**
 * Ledger evidence operations (Sprint 5 — Seal): litigation holds, trusted-time anchoring,
 * claims-pack assembly (draft → sealed → released), regulatory exports, and the scoped
 * exchange-portal read path (consent-gated, fully access-audited).
 */
const HoldSchema = z.object({ name: z.string().min(1), reason: z.string().optional(), fromSequence: z.number().int().optional(), toSequence: z.number().int().optional() });
const PackSchema = z.object({
  incident: z.string().optional(),
  audience: z.enum(["claims_adjuster", "outside_counsel", "regulator", "broker"]),
  fromSequence: z.number().int().nonnegative(),
  toSequence: z.number().int().nonnegative(),
  redactFields: z.array(z.string()).optional(),
});

export function registerSealRoutes(app: FastifyInstance, platform: Platform): void {
  // --- Litigation holds ---
  app.post<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/holds", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:export", tenantId);
    if (!principal) return reply;
    const parsed = HoldSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, data: null, error: { code: "invalid_request", issues: parsed.error.issues } });
    const hold = await platform.evidenceOps.createHold({ tenantId, ...parsed.data, createdBy: principal.subject });
    return reply.status(201).send({ success: true, data: { hold }, error: null });
  });

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/holds", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:read", tenantId);
    if (!principal) return reply;
    return reply.send({ success: true, data: { holds: await platform.evidenceOps.listHolds(tenantId) }, error: null });
  });

  app.post<{ Params: { tenantId: string; id: string } }>("/v1/tenants/:tenantId/holds/:id/release", async (request, reply) => {
    const { tenantId, id } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:export", tenantId);
    if (!principal) return reply;
    await platform.evidenceOps.releaseHold(tenantId, id);
    return reply.send({ success: true, data: { id, status: "released" }, error: null });
  });

  // --- Trusted-time anchoring ---
  app.post<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/anchor", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:export", tenantId);
    if (!principal) return reply;
    const anchored = await platform.anchorHead(tenantId);
    return reply.send({ success: true, data: { anchored }, error: null });
  });

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/anchors", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:read", tenantId);
    if (!principal) return reply;
    return reply.send({ success: true, data: { anchors: await platform.evidenceOps.listAnchors(tenantId) }, error: null });
  });

  // --- Claims packs ---
  app.post<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/claims-packs", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:export", tenantId);
    if (!principal) return reply;
    const parsed = PackSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ success: false, data: null, error: { code: "invalid_request", issues: parsed.error.issues } });
    const pack = await platform.evidenceOps.createPack({ tenantId, ...parsed.data });
    return reply.status(201).send({ success: true, data: { pack }, error: null });
  });

  app.post<{ Params: { tenantId: string; id: string } }>("/v1/tenants/:tenantId/claims-packs/:id/seal", async (request, reply) => {
    const { tenantId, id } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:export", tenantId);
    if (!principal) return reply;
    const pack = await platform.evidenceOps.getPack(tenantId, id);
    if (!pack) return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });

    // Litigation hold disables redaction on covered records (preserve the original).
    if (pack.redactFields.length > 0) {
      for (let seq = pack.fromSequence; seq <= pack.toSequence; seq++) {
        if (await platform.evidenceOps.isUnderHold(tenantId, seq)) {
          return reply.status(409).send({ success: false, data: null, error: { code: "redaction_disabled_under_hold", sequence: seq } });
        }
      }
    }

    const records = await platform.store.getRange(tenantId, pack.fromSequence, pack.toSequence);
    if (records.length === 0) return reply.status(400).send({ success: false, data: null, error: { code: "empty_range" } });

    // Anchor the pack's head with the independent TSA so the bundle proves its head's time.
    const headHash = records[records.length - 1]!.record.seal.contentHash;
    const ts = await createTimestamp(platform.tsa, `tsa-${platform.config.env}`, headHash, new Date().toISOString());
    await platform.evidenceOps.createAnchor({
      id: randomUUID(),
      tenantId,
      sequence: pack.toSequence,
      headHash,
      tsaTime: ts.time,
      tsaSignature: ts.signature,
      tsaKeyId: ts.keyId,
    });

    const bundle = assembleClaimsPack({
      id: pack.id,
      tenantId,
      incident: pack.incident ?? "incident",
      audience: pack.audience as Audience,
      fromSequence: pack.fromSequence,
      toSequence: pack.toSequence,
      redactFields: pack.redactFields,
      records,
      keyset: await platform.signer.publishKeyset(),
      tsaKeyset: await platform.tsa.publishKeyset(),
      anchors: [ts],
      sealedBy: principal.subject,
      sealedAt: new Date().toISOString(),
    });

    // Self-check before sealing.
    const verification = verifyClaimsPack(bundle);
    const sealed = await platform.evidenceOps.sealPack(tenantId, id, bundle);
    return reply.send({ success: true, data: { pack: sealed, verification }, error: null });
  });

  app.post<{ Params: { tenantId: string; id: string }; Body: { releasedTo?: string } }>(
    "/v1/tenants/:tenantId/claims-packs/:id/release",
    async (request, reply) => {
      const { tenantId, id } = request.params;
      const principal = await requireAuth(platform, request, reply, "records:export", tenantId);
      if (!principal) return reply;
      const releasedTo = request.body?.releasedTo ?? "external";
      const released = await platform.evidenceOps.releasePack(tenantId, id, releasedTo);
      if (!released) return reply.status(409).send({ success: false, data: null, error: { code: "not_sealed" } });
      await platform.accessAudit.record({ tenantId, actor: principal.subject, actorKind: principal.kind, action: "share", resource: `claims-pack:${id}`, metadata: { releasedTo } });
      return reply.send({ success: true, data: { pack: released }, error: null });
    },
  );

  // Exchange portal read path — consent-gated, access-audited.
  app.get<{ Params: { tenantId: string; id: string } }>("/v1/tenants/:tenantId/claims-packs/:id", async (request, reply) => {
    const { tenantId, id } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:read", tenantId);
    if (!principal) return reply;
    const pack = await platform.evidenceOps.getPack(tenantId, id);
    if (!pack) return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
    await platform.accessAudit.record({ tenantId, actor: principal.subject, actorKind: principal.kind, action: "export", resource: `claims-pack:${id}` });
    return reply.send({ success: true, data: { pack }, error: null });
  });

  app.get<{ Params: { tenantId: string } }>("/v1/tenants/:tenantId/claims-packs", async (request, reply) => {
    const { tenantId } = request.params;
    const principal = await requireAuth(platform, request, reply, "records:read", tenantId);
    if (!principal) return reply;
    return reply.send({ success: true, data: { packs: await platform.evidenceOps.listPacks(tenantId) }, error: null });
  });

  // --- Regulatory exports ---
  app.get<{ Params: { tenantId: string; format: string }; Querystring: { from?: string; to?: string } }>(
    "/v1/tenants/:tenantId/exports/:format",
    async (request, reply) => {
      const { tenantId, format } = request.params;
      const principal = await requireAuth(platform, request, reply, "records:export", tenantId);
      if (!principal) return reply;
      const valid: RegulatoryFormat[] = ["finra", "eu_ai_act_12", "sr_11_7"];
      if (!valid.includes(format as RegulatoryFormat)) return reply.status(400).send({ success: false, data: null, error: { code: "unknown_format" } });
      const head = await platform.store.getHead(tenantId);
      const from = Number(request.query.from ?? 0);
      const to = Number(request.query.to ?? head?.sequence ?? 0);
      const records = (await platform.store.getRange(tenantId, from, to)).map((r) => r.record);
      const exportDoc = generateRegulatoryExport(format as RegulatoryFormat, tenantId, records);
      await platform.accessAudit.record({ tenantId, actor: principal.subject, actorKind: principal.kind, action: "export", resource: `regulatory:${format}` });
      return reply.send({ success: true, data: { export: exportDoc }, error: null });
    },
  );
}
