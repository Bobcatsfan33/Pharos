import Fastify, { type FastifyInstance } from "fastify";
import type { LiabilityInput, PharosClient, ActionInput } from "@pharos/sdk";

/**
 * Zero-code governance gateway.
 *
 * An agent's HTTP egress is routed through this proxy with no library integration — only a
 * base-URL/proxy config change (matching the no-library posture of network security
 * platforms). Each outbound request is mapped to a Pharos action and governed:
 *
 *   allow / modify -> forwarded to the target, response returned
 *   block          -> 403 with the rule citations
 *   escalate       -> 202 + escalationId; the request is held until a human verdict, then
 *                     POST /__resume/:id claims (exactly-once) and forwards it
 *
 * The held-request map is in-memory request state (not evidence); the exactly-once
 * guarantee comes from the Pharos server-side claim, not the gateway.
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
}

interface HeldRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

const DEFAULT_LIABILITY: LiabilityInput = {
  mandate: null,
  oversightMode: "human_on_loop",
  blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
  modelMetadata: null,
};

export function createGatewayApp(opts: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const held = new Map<string, HeldRequest>();

  async function forward(req: HeldRequest): Promise<{ status: number; body: unknown }> {
    const res = await fetchImpl(`${opts.target}${req.path}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  function actionFor(req: HeldRequest): {
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

  // Resume a held request after a human verdict; exactly-once via the Pharos claim.
  app.post<{ Params: { id: string } }>("/__resume/:id", async (request, reply) => {
    const id = request.params.id;
    const req = held.get(id);
    if (!req) return reply.code(404).send({ error: "no held request for escalation" });
    const claim = await opts.client.claim(opts.tenantId, id);
    if (!claim.claimed)
      return reply.code(409).send({ error: "not claimable (rejected or already resumed)" });
    held.delete(id);
    const forwarded = await forward(req);
    return reply.code(forwarded.status).send({ resumed: true, response: forwarded.body });
  });

  app.all("/*", async (request, reply) => {
    const req: HeldRequest = {
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
    if (submitted.escalation) held.set(submitted.escalation.id, req);
    return reply.code(202).send({ held: true, escalationId: submitted.escalation?.id ?? null });
  });

  return app;
}
