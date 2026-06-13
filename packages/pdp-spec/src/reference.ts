import { PDP_SPEC_VERSION, type Pdp, type PdpRequest, type PdpResponse, type PdpCitation } from "./contract.js";

/**
 * An INDEPENDENT reference PDP — a minimal, standalone implementation of the open contract
 * with no dependency on the Pharos cascade, judges, or storage. Its existence and conformance
 * demonstrate that the spec is implementable by parties other than Pharos. It implements only
 * a tiny deterministic rule set; that is sufficient to conform (conformance tests the contract,
 * not a specific policy).
 */
export interface ReferencePdpOptions {
  blockedActionTypes?: string[];
  defaultDeadlineMs?: number;
}

export function createReferencePdp(opts: ReferencePdpOptions = {}): Pdp {
  const blocked = new Set(opts.blockedActionTypes ?? ["system.shutdown"]);
  const defaultDeadline = opts.defaultDeadlineMs ?? 800;

  return (request: PdpRequest): PdpResponse => {
    const start = Date.now();
    const deadlineMs = request.deadlineMs ?? defaultDeadline;
    const reversible = request.liability.blastRadius.reversibility === "reversible";

    // Timeout semantics: an unmeetable deadline yields a fail-mode response.
    if (deadlineMs <= 0) {
      return {
        specVersion: PDP_SPEC_VERSION,
        decision: reversible ? "allow" : "escalate",
        tierReached: 1,
        riskScore: 0.5,
        ruleCitations: [{ ruleId: reversible ? "deadline-fail-open" : "deadline-fail-closed", pack: "reference" }],
        failMode: reversible ? "fail_open" : "fail_closed",
        judgeVersion: null,
        latency: { totalMs: Date.now() - start, deadlineMs, deadlineBreached: true },
      };
    }

    const citations: PdpCitation[] = [];
    let decision: PdpResponse["decision"] = "allow";
    let riskScore = 0;

    if (blocked.has(request.action.type)) {
      decision = "block";
      riskScore = 0.9;
      citations.push({ ruleId: "blocked-action-type", pack: "reference", description: `Action ${request.action.type} is on the deny list.` });
    }

    const max = readLimit(request.liability.mandate?.limits);
    const amount = request.liability.blastRadius.financialAmount ?? 0;
    if (max !== null && amount > max) {
      decision = "block";
      riskScore = 1;
      citations.push({ ruleId: "mandate-limit-exceeded", pack: "reference", description: `Amount ${amount} exceeds mandate limit ${max}.` });
    }

    if (decision === "allow" && !reversible && request.liability.oversightMode !== "autonomous" && amount > 0) {
      decision = "escalate";
      riskScore = Math.max(riskScore, 0.4);
      citations.push({ ruleId: "irreversible-oversight", pack: "reference", description: "Irreversible action under human oversight escalated." });
    }

    return {
      specVersion: PDP_SPEC_VERSION,
      decision,
      tierReached: 1,
      riskScore,
      ruleCitations: citations,
      failMode: null,
      judgeVersion: null,
      latency: { totalMs: Date.now() - start, deadlineMs, deadlineBreached: false },
    };
  };
}

function readLimit(limits: Record<string, unknown> | undefined): number | null {
  if (!limits) return null;
  for (const k of ["maxAmount", "ceiling", "maxTransfer"]) {
    const v = limits[k];
    if (typeof v === "number") return v;
  }
  return null;
}
