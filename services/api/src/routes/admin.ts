import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isPermission, type Permission } from "@pharos/identity";
import type { Platform } from "../platform.js";
import { requireAuth, requireAdminToken } from "../auth.js";

/**
 * Tenant lifecycle, API-key management, and access-audit reads.
 *
 * Tenant provisioning is a platform-operator action guarded by the bootstrap admin
 * token; it returns an initial tenant-admin API key (shown once) to break the
 * chicken-and-egg of "who creates the first key". Everything thereafter is governed by
 * RBAC within the tenant.
 */
const CreateTenantSchema = z.object({
  tenantId: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "tenantId must be kebab-case"),
  displayName: z.string().min(1),
  retainEvidenceOnDelete: z.boolean().optional(),
});

const CreateKeySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).min(1),
});

const ALL_PERMS: Permission[] = [
  "actions:write",
  "records:read",
  "records:export",
  "chain:verify",
  "policies:read",
  "policies:write",
  "reviews:read",
  "reviews:act",
  "tenants:manage",
  "keys:manage",
  "audit:read",
];

export function registerAdminRoutes(app: FastifyInstance, platform: Platform): void {
  // Provision a tenant + initial tenant-admin key. Guarded by the platform admin token.
  app.post("/v1/admin/tenants", async (request, reply) => {
    if (!requireAdminToken(platform, request, reply)) return reply;
    const parsed = CreateTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        data: null,
        error: { code: "invalid_request", issues: parsed.error.issues },
      });
    }
    const tenant = await platform.tenants.createTenant(parsed.data);
    // Pre-create the per-tenant signing key so the first action can be sealed immediately.
    await platform.signer.ensureKey(tenant.kmsKeyName);
    const { record, plaintext } = await platform.apiKeys.create(
      tenant.tenantId,
      "bootstrap tenant-admin",
      ALL_PERMS,
    );
    return reply.status(201).send({
      success: true,
      data: { tenant, adminKey: { keyId: record.keyId, plaintext, scopes: record.scopes } },
      error: null,
    });
  });

  app.get("/v1/admin/tenants", async (request, reply) => {
    if (!requireAdminToken(platform, request, reply)) return reply;
    const tenants = await platform.tenants.listTenants();
    return reply.send({ success: true, data: { tenants }, error: null });
  });

  app.post<{ Params: { tenantId: string }; Body: { status: string } }>(
    "/v1/admin/tenants/:tenantId/status",
    async (request, reply) => {
      if (!requireAdminToken(platform, request, reply)) return reply;
      const status = request.body?.status;
      if (status !== "active" && status !== "suspended") {
        return reply
          .status(400)
          .send({ success: false, data: null, error: { code: "invalid_status" } });
      }
      await platform.tenants.setStatus(request.params.tenantId, status);
      return reply.send({
        success: true,
        data: { tenantId: request.params.tenantId, status },
        error: null,
      });
    },
  );

  app.delete<{ Params: { tenantId: string } }>(
    "/v1/admin/tenants/:tenantId",
    async (request, reply) => {
      if (!requireAdminToken(platform, request, reply)) return reply;
      const result = await platform.tenants.deleteTenant(request.params.tenantId);
      return reply.send({ success: true, data: result, error: null });
    },
  );

  // --- Tenant-scoped API key management (keys:manage) ---
  app.post<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/keys",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "keys:manage", tenantId);
      if (!principal) return reply;
      const parsed = CreateKeySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          data: null,
          error: { code: "invalid_request", issues: parsed.error.issues },
        });
      }
      const scopes = parsed.data.scopes.filter(isPermission);
      if (scopes.length !== parsed.data.scopes.length) {
        return reply
          .status(400)
          .send({ success: false, data: null, error: { code: "unknown_scope" } });
      }
      const { record, plaintext } = await platform.apiKeys.create(
        tenantId,
        parsed.data.name,
        scopes,
      );
      return reply
        .status(201)
        .send({ success: true, data: { keyId: record.keyId, plaintext, scopes }, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/keys",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "keys:manage", tenantId);
      if (!principal) return reply;
      const keys = await platform.apiKeys.list(tenantId);
      return reply.send({ success: true, data: { keys }, error: null });
    },
  );

  app.post<{ Params: { tenantId: string; keyId: string } }>(
    "/v1/tenants/:tenantId/keys/:keyId/rotate",
    async (request, reply) => {
      const { tenantId, keyId } = request.params;
      const principal = await requireAuth(platform, request, reply, "keys:manage", tenantId);
      if (!principal) return reply;
      const rotated = await platform.apiKeys.rotate(tenantId, keyId);
      if (!rotated)
        return reply.status(404).send({ success: false, data: null, error: { code: "not_found" } });
      return reply.status(201).send({
        success: true,
        data: {
          keyId: rotated.record.keyId,
          plaintext: rotated.plaintext,
          scopes: rotated.record.scopes,
          rotatedFrom: keyId,
        },
        error: null,
      });
    },
  );

  app.post<{ Params: { tenantId: string; keyId: string } }>(
    "/v1/tenants/:tenantId/keys/:keyId/revoke",
    async (request, reply) => {
      const { tenantId, keyId } = request.params;
      const principal = await requireAuth(platform, request, reply, "keys:manage", tenantId);
      if (!principal) return reply;
      await platform.apiKeys.revoke(tenantId, keyId);
      return reply.send({ success: true, data: { keyId, status: "revoked" }, error: null });
    },
  );

  // --- Access audit (audit:read) ---
  app.get<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/audit",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "audit:read", tenantId);
      if (!principal) return reply;
      const entries = await platform.accessAudit.list(tenantId);
      return reply.send({ success: true, data: { entries }, error: null });
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    "/v1/tenants/:tenantId/audit/verify",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "audit:read", tenantId);
      if (!principal) return reply;
      const report = await platform.accessAudit.verify(tenantId);
      return reply
        .status(report.ok ? 200 : 409)
        .send({ success: report.ok, data: report, error: null });
    },
  );
}
