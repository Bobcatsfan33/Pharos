/** Public SDK types. Standalone (no workspace deps) so the package can be published as-is. */
import type { MandateToken } from "./mandateToken.js";

export type Decision = "allow" | "block" | "modify" | "escalate";
export type Reversibility = "reversible" | "irreversible";
export type OversightMode = "autonomous" | "human_in_loop" | "human_on_loop";

export interface ActionInput {
  type: string;
  agentId: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface BlastRadius {
  financialAmount?: number;
  currency?: string;
  reversibility: Reversibility;
  notes?: string;
}

export interface LiabilityInput {
  mandate?: null | {
    id: string;
    scope: string;
    limits?: Record<string, unknown>;
    grantor: string;
    expiresAt?: string | null;
    version?: string;
  };
  oversightMode: OversightMode;
  blastRadius: BlastRadius;
  modelMetadata?: null | { provider: string; model: string; version?: string };
}

export interface Verdict {
  decision: Decision;
  tierReached: 1 | 2 | 3 | "human";
  riskScore: number;
  ruleCitations: Array<{ ruleId: string; pack: string; clause?: string; description?: string }>;
  failMode: "fail_open" | "fail_closed" | null;
  judgeVersion: string | null;
  latency: {
    totalMs: number;
    perTier: Record<string, number>;
    deadlineMs: number;
    deadlineBreached: boolean;
  };
}

export interface SubmitResult {
  verdict: Verdict;
  record: { content: { id: string; sequence: number } } & Record<string, unknown>;
  escalation: { id: string; status: string } | null;
  /** True when the verdict came from a local fail-mode default (the platform was unreachable). */
  localFallback?: boolean;
  /**
   * Set when the verdict was decided locally from the MandateToken (Workstream A):
   *   "mandate-token-invalid" — the token failed offline verification: a Tier-1 block;
   *   "mandate-token-allow"   — `localAllow` was on and the token admitted a reversible,
   *                             zero-amount, in-scope action: an optimistic allow.
   * Either way the same request is still submitted, so a sealed record exists for the decision;
   * `sealed` resolves to the server's result (which is authoritative and may diverge).
   */
  localVerdict?: "mandate-token-invalid" | "mandate-token-allow";
  sealed?: Promise<SubmitResult>;
}

/** The published entry for a tenant's mandate root key (from GET /v1/keyset). */
export type { MandateRootKey, MandateToken } from "./mandateToken.js";

export interface SubmitInput {
  tenantId: string;
  action: ActionInput;
  liability: LiabilityInput;
  mandateId?: string;
  /**
   * A MandateToken the agent holds (Workstream A). Verified locally when the client was
   * configured with the tenant's mandate root keys; always verified and sealed by the server.
   * Mutually exclusive with `mandateId`.
   */
  mandateToken?: MandateToken;
  idempotencyKey?: string;
}

export interface Escalation {
  id: string;
  status: "pending" | "approved" | "modified" | "rejected" | "cancelled";
  resolution: { decision: string; rationale: string; modifiedAction: unknown } | null;
  resumeClaimId?: string | null;
  [k: string]: unknown;
}

export interface ClaimResult {
  claimed: boolean;
  status: string;
  resolution: Escalation["resolution"];
  escalation: Escalation;
}

export class PharosError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PharosError";
  }
}

export type TelemetryEvent =
  | { type: "submit"; attempt: number; latencyMs: number; decision?: Decision }
  | { type: "retry"; attempt: number; error: string }
  | { type: "fallback"; failMode: "fail_open" | "fail_closed" }
  | { type: "resume"; escalationId: string; claimed: boolean }
  | {
      type: "local-verdict";
      verdict: "mandate-token-invalid" | "mandate-token-allow";
      code?: string;
    }
  /** The server's sealed verdict disagreed with a local decision (or the submission failed). */
  | { type: "local-verdict-diverged"; local: Decision; sealed: Decision | null; error?: string };
