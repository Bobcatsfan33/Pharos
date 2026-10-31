import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mintMandateToken, type MandateLimits } from "@pharos/core";
import type { Platform } from "../platform.js";
import { requireAuth } from "../auth.js";

/** The tenant's mandate signing key family. Published through /v1/keyset like every key. */
export const mandateKeyName = (tenantId: string): string => `mandate:${tenantId}`;

/**
 * Mint a MandateToken (Workstream A) for a stored, active mandate. The token may already be
 * narrower than the mandate; it can never be wider, because the stored mandate's ceiling and
 * expiry bound the authority block. Everything else the holder narrows offline.
 */
const MintTokenSchema = z.object({
  agentId: z.string().min(1),
  actionTypes: z.array(z.string().min(1)).min(1).optional(),
  resources: z.array(z.string().min(1)).min(1).optional(),
  expiresAt: z.string().datetime().optional(),
  /** Token lifetime when the mandate has no expiry and none is given. Default 24h. */
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(365 * 24 * 3600)
    .optional(),
  financialAmount: z.number().nonnegative().optional(),
  currency: z.string().min(1).optional(),
  reversibility: z.enum(["reversible", "irreversible", "any"]).optional(),
  citations: z.array(z.string().min(1)).optional(),
});

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
  app.post<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/mandates",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "policies:write", tenantId);
      if (!principal) return reply;
      const parsed = CreateMandateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          data: null,
          error: { code: "invalid_request", issues: parsed.error.issues },
        });
      }
      const mandate = await platform.mandates.create({ tenantId, ...parsed.data });
      return reply.status(201).send({ success: true, data: { mandate }, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/mandates",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "policies:read", tenantId);
      if (!principal) return reply;
      const mandates = await platform.mandates.list(tenantId);
      return reply.send({ success: true, data: { mandates }, error: null });
    },
  );

  app.post<{ Params: { tenantId: string; mandateId: string } }>(
    "/v1/tenants/:tenantId/mandates/:mandateId/token",
    async (request, reply) => {
      const { tenantId, mandateId } = request.params;
      const principal = await requireAuth(platform, request, reply, "policies:write", tenantId);
      if (!principal) return reply;
      const parsed = MintTokenSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          data: null,
          error: { code: "invalid_request", issues: parsed.error.issues },
        });
      }
      const body = parsed.data;
      const mandate = await platform.mandates.getActive(tenantId, mandateId);
      if (!mandate) {
        return reply
          .status(404)
          .send({ success: false, data: null, error: { code: "mandate_not_found", mandateId } });
      }
      const now = new Date();
      const limits = mandate.limits as Record<string, unknown>;
      const ceiling = typeof limits.maxAmount === "number" ? limits.maxAmount : undefined;
      // The authority block cannot exceed the stored mandate.
      if (
        body.financialAmount !== undefined &&
        ceiling !== undefined &&
        body.financialAmount > ceiling
      ) {
        return reply.status(400).send({
          success: false,
          data: null,
          error: { code: "token_wider_than_mandate", field: "financialAmount", ceiling },
        });
      }
      const mandateExpiry = mandate.expiresAt ? new Date(mandate.expiresAt).getTime() : null;
      const requested = body.expiresAt
        ? new Date(body.expiresAt).getTime()
        : (mandateExpiry ?? now.getTime() + (body.ttlSeconds ?? 24 * 3600) * 1000);
      if (mandateExpiry !== null && requested > mandateExpiry) {
        return reply.status(400).send({
          success: false,
          data: null,
          error: {
            code: "token_wider_than_mandate",
            field: "expiresAt",
            ceiling: mandate.expiresAt,
          },
        });
      }
      if (requested <= now.getTime()) {
        return reply
          .status(400)
          .send({ success: false, data: null, error: { code: "token_already_expired" } });
      }
      const tokenLimits: MandateLimits = {};
      const amount = body.financialAmount ?? ceiling;
      if (amount !== undefined) tokenLimits.financialAmount = amount;
      const currency =
        body.currency ?? (typeof limits.currency === "string" ? limits.currency : undefined);
      if (currency !== undefined) tokenLimits.currency = currency;
      if (body.reversibility !== undefined) tokenLimits.reversibility = body.reversibility;
      const declaredTypes = Array.isArray(limits.actionTypes)
        ? (limits.actionTypes as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
      const actionTypes = body.actionTypes ?? (declaredTypes.length > 0 ? declaredTypes : ["*"]);

      const keyId = await platform.signer.ensureKey(mandateKeyName(tenantId));
      const token = await mintMandateToken(
        {
          tenantId,
          agentId: body.agentId,
          mandateId,
          grantor: mandate.grantor,
          issuedAt: now.toISOString(),
          expiresAt: new Date(requested).toISOString(),
          scope: { actionTypes, resources: body.resources ?? ["*"] },
          limits: tokenLimits,
          citations: body.citations ?? [],
        },
        platform.signer,
        keyId,
      );
      const rootKey = await platform.signer.getPublicKey(keyId);
      await platform.accessAudit.record({
        tenantId,
        actor: principal.subject,
        actorKind: principal.kind,
        action: "mint",
        resource: `mandate-token:${mandateId}`,
      });
      return reply.status(201).send({ success: true, data: { token, rootKey }, error: null });
    },
  );

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
