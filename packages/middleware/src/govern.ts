import type {
  ActionInput,
  ClaimResult,
  Escalation,
  LiabilityInput,
  SubmitInput,
  SubmitResult,
} from "@pharos/sdk";

/**
 * The shared governor contract every framework middleware delegates to.
 *
 * A governed tool call submits an action to Pharos and enforces the verdict:
 *   allow / modify  -> run the underlying tool (modify runs with the human-modified args)
 *   block / reject  -> throw PharosBlockedError (the agent sees a tool error)
 *   escalate        -> await a human verdict, then resume exactly once
 *
 * Implemented once here so all middlewares (LangChain/LangGraph, OpenAI Agents, Anthropic
 * SDK, plus the Python CrewAI / MS Agent Framework adapters) share identical semantics and
 * pass one conformance suite.
 */
export interface Governor {
  submit(input: SubmitInput): Promise<SubmitResult>;
  awaitResolution(
    tenantId: string,
    id: string,
    opts?: { pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<Escalation>;
  claim(tenantId: string, id: string): Promise<ClaimResult>;
}

export class PharosBlockedError extends Error {
  constructor(
    public readonly reason: string,
    public readonly citations: SubmitResult["verdict"]["ruleCitations"] = [],
  ) {
    super(`action blocked by Pharos: ${reason}`);
    this.name = "PharosBlockedError";
  }
}

export interface GovernOptions<Args> {
  tenantId: string;
  agentId: string;
  toolName: string;
  /** Map tool args to the action + liability. Defaults to a reversible, autonomous action. */
  mapAction?: (args: Args) => {
    action?: Partial<ActionInput>;
    liability?: LiabilityInput;
    mandateId?: string;
  };
  awaitOpts?: { pollIntervalMs?: number; timeoutMs?: number };
}

const DEFAULT_LIABILITY: LiabilityInput = {
  mandate: null,
  oversightMode: "autonomous",
  blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
  modelMetadata: null,
};

function buildInput<Args>(opts: GovernOptions<Args>, args: Args): SubmitInput {
  const mapped = opts.mapAction?.(args) ?? {};
  return {
    tenantId: opts.tenantId,
    action: {
      type: mapped.action?.type ?? `tool.${opts.toolName}`,
      agentId: mapped.action?.agentId ?? opts.agentId,
      sessionId: mapped.action?.sessionId,
      payload: (mapped.action?.payload ?? (args as Record<string, unknown>)) as Record<
        string,
        unknown
      >,
    },
    liability: mapped.liability ?? DEFAULT_LIABILITY,
    mandateId: mapped.mandateId,
  };
}

/**
 * Wrap a tool function so every invocation is governed by Pharos. Returns the tool's
 * result when permitted; throws PharosBlockedError when not. Resume after escalation is
 * exactly-once (the server claim gates the side effect).
 */
export function governTool<Args, R>(
  governor: Governor,
  opts: GovernOptions<Args>,
  tool: (args: Args) => Promise<R> | R,
): (args: Args) => Promise<R> {
  return async (args: Args): Promise<R> => {
    const input = buildInput(opts, args);
    const submitted = await governor.submit(input);
    const decision = submitted.verdict.decision;

    if (decision === "allow" || decision === "modify") {
      return await tool(args);
    }
    if (decision === "block") {
      throw new PharosBlockedError("tier-policy block", submitted.verdict.ruleCitations);
    }

    // escalate: park → human verdict → exactly-once resume.
    if (!submitted.escalation)
      throw new PharosBlockedError("escalated without a continuation handle");
    const resolved = await governor.awaitResolution(
      input.tenantId,
      submitted.escalation.id,
      opts.awaitOpts,
    );
    if (resolved.status === "rejected") {
      throw new PharosBlockedError("rejected by reviewer", []);
    }
    const claim = await governor.claim(input.tenantId, submitted.escalation.id);
    if (!claim.claimed) throw new PharosBlockedError("already resumed elsewhere (exactly-once)");

    const modified = claim.resolution?.modifiedAction as Args | undefined;
    return await tool(modified ?? args);
  };
}
