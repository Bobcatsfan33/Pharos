import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { LiabilityInput, PharosClient, ActionInput } from "@getpharos/sdk";
import type {
  HeldGatewayRequest,
  HeldRequestAcquireResult,
  HeldRequestStore,
} from "@pharos/storage";

/**
 * Zero-code governance gateway.
 *
 * An agent's HTTP egress is routed through this proxy with no library integration — only a
 * base-URL/proxy config change (matching the no-library posture of network security
 * platforms). Each outbound request is mapped to a Pharos action and governed:
 *
 *   allow / modify -> forwarded to the target, response returned
 *   block          -> 403 with the rule citations
 *   escalate       -> 202 + escalationId; the request is durably held until a human verdict,
 *                     then POST /__resume/:id leases, claims, and forwards it
 */
export interface GatewayOptions {
  client: PharosClient;
  tenantId: string;
  agentId: string;
  /** Base URL of the real upstream the agent intended to call. */
  target: string;
  /** Map a request to an action + liability. Defaults to a reversible egress action. */
  mapAction?: (req: { method: string; path: string; body: unknown }) => {
    action?: Partial<ActionInput>;
    liability?: LiabilityInput;
    mandateId?: string;
  };
  fetchImpl?: typeof fetch;
  /**
   * Durable deployments inject PostgresHeldRequestStore. The in-memory default is
   * intentionally limited to local/test composition; server.ts refuses it in production.
   */
  heldRequestStore?: HeldRequestStore;
}

const DEFAULT_LIABILITY: LiabilityInput = {
  mandate: null,
  oversightMode: "human_on_loop",
  blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
  modelMetadata: null,
};

class InMemoryHeldRequestStore implements HeldRequestStore {
  private readonly held = new Map<
    string,
    { request: HeldGatewayRequest; leaseToken: string | null }
  >();

  async save(tenantId: string, escalationId: string, request: HeldGatewayRequest): Promise<void> {
    const key = `${tenantId}\0${escalationId}`;
    if (!this.held.has(key)) this.held.set(key, { request, leaseToken: null });
  }

  async acquire(tenantId: string, escalationId: string): Promise<HeldRequestAcquireResult> {
    const value = this.held.get(`${tenantId}\0${escalationId}`);
    if (!value) return { status: "missing" };
    if (value.leaseToken) return { status: "busy" };
    value.leaseToken = randomUUID();
    return { status: "acquired", leaseToken: value.leaseToken, request: value.request };
  }

  async complete(tenantId: string, escalationId: string, leaseToken: string): Promise<boolean> {
    const key = `${tenantId}\0${escalationId}`;
    const value = this.held.get(key);
    if (!value || value.leaseToken !== leaseToken) return false;
    return this.held.delete(key);
  }

  async release(
    tenantId: string,
    escalationId: string,
    leaseToken: string,
    _error: string,
  ): Promise<boolean> {
    const value = this.held.get(`${tenantId}\0${escalationId}`);
    if (!value || value.leaseToken !== leaseToken) return false;
    value.leaseToken = null;
    return true;
  }
}

export function createGatewayApp(opts: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const held = opts.heldRequestStore ?? new InMemoryHeldRequestStore();

  async function forward(
    req: HeldGatewayRequest,
    escalationId?: string,
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (escalationId) {
      // Generic HTTP cannot guarantee exactly-once execution after an ambiguous network
      // failure. This stable key gives a compliant upstream the information required to
      // deduplicate a recovery retry.
      headers["idempotency-key"] = `pharos-escalation-${escalationId}`;
      headers["x-pharos-escalation-id"] = escalationId;
    }
    const res = await fetchImpl(`${opts.target}${req.path}`, {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  function actionFor(req: HeldGatewayRequest): {
    action: ActionInput;
    liability: LiabilityInput;
    mandateId?: string;
  } {
    const mapped = opts.mapAction?.(req) ?? {};
    return {
      action: {
        type: mapped.action?.type ?? `egress.${req.method.toLowerCase()}`,
        agentId: mapped.action?.agentId ?? opts.agentId,
        payload: (mapped.action?.payload ?? {
          path: req.path,
          ...(typeof req.body === "object" ? req.body : { body: req.body }),
        }) as Record<string, unknown>,
      },
      liability: mapped.liability ?? DEFAULT_LIABILITY,
      mandateId: mapped.mandateId,
    };
  }

  // Resume after human review. The claim is at-most-once authorization; the stable
  // upstream idempotency key closes the ambiguous retry window for compliant targets.
  app.post<{ Params: { id: string } }>("/__resume/:id", async (request, reply) => {
    const id = request.params.id;
    const acquired = await held.acquire(opts.tenantId, id);
    if (acquired.status === "missing") {
      return reply.code(404).send({ error: "no held request for escalation" });
    }
    if (acquired.status === "busy") {
      return reply.code(409).send({ error: "held request delivery is already in progress" });
    }

    try {
      const claim = await opts.client.claim(opts.tenantId, id);
      const alreadyClaimedForRecovery =
        !claim.claimed &&
        (claim.status === "approved" || claim.status === "modified") &&
        Boolean(claim.escalation["resumedAt"]);
      if (!claim.claimed && !alreadyClaimedForRecovery) {
        await held.release(
          opts.tenantId,
          id,
          acquired.leaseToken,
          `not claimable: ${claim.status}`,
        );
        return reply.code(409).send({ error: "not claimable (rejected or already resumed)" });
      }

      const forwarded = await forward(acquired.request, id);
      const completed = await held.complete(opts.tenantId, id, acquired.leaseToken);
      if (!completed) {
        throw new Error("held-request lease was lost before delivery completion");
      }
      return reply.code(forwarded.status).send({
        resumed: true,
        recoveredClaim: alreadyClaimedForRecovery,
        response: forwarded.body,
      });
    } catch (error) {
      await held.release(opts.tenantId, id, acquired.leaseToken, (error as Error).message);
      throw error;
    }
  });

  app.all("/*", async (request, reply) => {
    const req: HeldGatewayRequest = {
      method: request.method,
      path: request.url,
      body: request.body,
      headers: {},
    };
    const { action, liability, mandateId } = actionFor(req);
    const submitted = await opts.client.submit({
      tenantId: opts.tenantId,
      action,
      liability,
      mandateId,
    });
    const decision = submitted.verdict.decision;

    if (decision === "allow" || decision === "modify") {
      const forwarded = await forward(req);
      reply.header("x-pharos-decision", decision);
      return reply.code(forwarded.status).send(forwarded.body);
    }
    if (decision === "block") {
      return reply.code(403).send({ blocked: true, citations: submitted.verdict.ruleCitations });
    }
    // escalate: hold and return a continuation handle.
    if (!submitted.escalation) {
      return reply.code(502).send({ error: "escalation verdict did not include a continuation" });
    }
    await held.save(opts.tenantId, submitted.escalation.id, req);
    return reply.code(202).send({ held: true, escalationId: submitted.escalation.id });
  });

  return app;
}
