import type { FastifyInstance } from "fastify";
import { computeInvoice, reconcile, DEFAULT_PRICEBOOK, type Usage } from "@pharos/billing";
import { SHIPPED_PACKS } from "@pharos/policy";
import type { Platform } from "../platform.js";
import { requireAuth } from "../auth.js";

/**
 * Metering & billing routes for the three-part commercial model. Usage is metered from the
 * authoritative recorded-action count, so an invoice reconciles to recorded usage exactly.
 */
function periodBounds(period?: string): { from?: string; to?: string; period: string } {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return { period: period ?? "all" };
  const [y, m] = period.split("-").map(Number);
  const from = new Date(Date.UTC(y!, m! - 1, 1)).toISOString();
  const to = new Date(Date.UTC(m === 12 ? y! + 1 : y!, m === 12 ? 0 : m!, 1)).toISOString();
  return { from, to, period };
}

async function usageFor(platform: Platform, tenantId: string, period?: string): Promise<Usage> {
  const { from, to, period: p } = periodBounds(period);
  const recordedActions = await platform.store.countInPeriod(tenantId, from, to);
  const activeCustom = (await platform.policyStore.getActiveArtifacts(tenantId)).length;
  return {
    tenantId,
    period: p,
    recordedActions,
    activePacks: Object.keys(SHIPPED_PACKS).length + activeCustom,
    riskProfileEnabled: true,
  };
}

export function registerBillingRoutes(app: FastifyInstance, platform: Platform): void {
  app.get<{ Params: { tenantId: string }; Querystring: { period?: string } }>(
    "/v1/tenants/:tenantId/billing/usage",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "audit:read", tenantId);
      if (!principal) return reply;
      const usage = await usageFor(platform, tenantId, request.query.period);
      return reply.send({ success: true, data: { usage }, error: null });
    },
  );

  app.post<{ Params: { tenantId: string }; Body: { period?: string } }>(
    "/v1/tenants/:tenantId/billing/invoice",
    async (request, reply) => {
      const { tenantId } = request.params;
      const principal = await requireAuth(platform, request, reply, "tenants:manage", tenantId);
      if (!principal) return reply;
      const usage = await usageFor(platform, tenantId, request.body?.period);
      const invoice = computeInvoice(usage, DEFAULT_PRICEBOOK);
      // Reconcile the metered quantity against the authoritative recorded count.
      const { from, to } = periodBounds(request.body?.period);
      const recorded = await platform.store.countInPeriod(tenantId, from, to);
      const reconciliation = reconcile(invoice, recorded);
      return reply.send({ success: true, data: { invoice, reconciliation }, error: null });
    },
  );
}
