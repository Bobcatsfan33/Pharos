/**
 * Open Policy Decision Point (PDP) contract v1.0 for AI agents.
 *
 * This is the public, vendor-neutral wire contract: an agent action goes in, a verdict comes
 * out, optionally bound to a signed evidence record. It is dependency-free so any vendor can
 * implement it. Pharos is the reference commercial implementation; this package also ships an
 * independent reference implementation and a conformance suite so non-Pharos PDPs can self-
 * certify.
 */
export const PDP_SPEC_VERSION = "1.0.0" as const;

export type PdpDecision = "allow" | "block" | "modify" | "escalate";
export type PdpReversibility = "reversible" | "irreversible";
export type PdpOversight = "autonomous" | "human_in_loop" | "human_on_loop";

export interface PdpRequest {
  /** The action the agent intends to take. */
  action: {
    type: string;
    agentId: string;
    payload?: Record<string, unknown>;
  };
  /** Liability context that governs the action. */
  liability: {
    mandate?: { id: string; limits?: Record<string, unknown> } | null;
    oversightMode: PdpOversight;
    blastRadius: { financialAmount?: number; currency?: string; reversibility: PdpReversibility };
  };
  /** Deadline within which the PDP MUST respond (default 800ms). */
  deadlineMs?: number;
}

export interface PdpCitation {
  ruleId: string;
  pack: string;
  clause?: string;
  description?: string;
}

/** Optional evidence-binding: a signature binding the verdict to a sealed record. */
export interface PdpEvidenceBinding {
  algorithm: "ed25519";
  contentHash: string; // 64-char hex
  keyId: string;
  signature: string; // base64
}

export interface PdpResponse {
  specVersion: string;
  decision: PdpDecision;
  tierReached: 1 | 2 | 3 | "human";
  riskScore: number; // [0,1]
  ruleCitations: PdpCitation[];
  failMode: "fail_open" | "fail_closed" | null;
  judgeVersion: string | null;
  latency: { totalMs: number; deadlineMs: number; deadlineBreached: boolean };
  /** Present when the PDP seals evidence; absent otherwise. */
  evidenceBinding?: PdpEvidenceBinding;
}

/** A PDP implementation under the open contract. */
export type Pdp = (request: PdpRequest) => Promise<PdpResponse> | PdpResponse;
