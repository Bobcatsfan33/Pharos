import {
  type ActionIntent,
  type LiabilityContext,
  type VerdictContext,
  type RuleCitation,
} from "../schema/actionRecord.js";

/**
 * The verdict request: an agent action plus the liability context that governs it.
 * This is the single ingestion shape — the same request that yields a verdict yields
 * the sealed evidence record.
 */
export interface VerdictRequest {
  tenantId: string;
  action: ActionIntent;
  liability: LiabilityContext;
}

export interface VerdictEngineOptions {
  deadlineMs: number;
  /** Action types that are denied outright at Tier 1. */
  blockedActionTypes?: string[];
}

/**
 * Sprint 0 decision engine — Tier 1 only (deterministic rules).
 *
 * This is deliberately honest about its scope: it implements the deterministic tier
 * of the cascade (mandate-limit enforcement, expiry, and an explicit deny list). The
 * statistical Tier 2 and the served-model Tier 3 are introduced in Sprint 2 (Lantern)
 * behind this same interface, with short-circuiting so a Tier-1 hit skips later tiers.
 */
export class VerdictEngine {
  constructor(private readonly opts: VerdictEngineOptions) {}

  evaluate(req: VerdictRequest, now: Date): VerdictContext {
    const start = process.hrtime.bigint();
    const citations: RuleCitation[] = [];
    let decision: VerdictContext["decision"] = "allow";
    let riskScore = 0;

    const { mandate, blastRadius } = req.liability;

    // Rule: expired mandate -> escalate to human.
    if (mandate?.expiresAt) {
      const expiry = new Date(mandate.expiresAt);
      if (expiry.getTime() <= now.getTime()) {
        decision = "escalate";
        riskScore = Math.max(riskScore, 0.6);
        citations.push({
          ruleId: "mandate-expired",
          pack: "core",
          clause: "mandate.expiresAt",
          description: `Mandate ${mandate.id} expired at ${mandate.expiresAt}; action requires human re-authorization.`,
        });
      }
    }

    // Rule: financial blast radius exceeds the mandate's monetary ceiling -> block.
    const maxAmount = readNumericLimit(mandate?.limits, ["maxAmount", "ceiling", "maxTransfer"]);
    if (mandate && maxAmount !== null && blastRadius.financialAmount > maxAmount) {
      decision = "block";
      riskScore = 1;
      citations.push({
        ruleId: "mandate-limit-exceeded",
        pack: "core",
        clause: "mandate.limits.maxAmount",
        description: `Action blast radius ${blastRadius.financialAmount} ${blastRadius.currency} exceeds mandate ${mandate.id} limit of ${maxAmount}.`,
      });
    }

    // Rule: explicit action-type deny list.
    if (this.opts.blockedActionTypes?.includes(req.action.type)) {
      if (decision !== "block") decision = "block";
      riskScore = Math.max(riskScore, 0.9);
      citations.push({
        ruleId: "action-type-blocked",
        pack: "core",
        clause: "policy.blockedActionTypes",
        description: `Action type "${req.action.type}" is on the tenant deny list.`,
      });
    }

    // Irreversible high-value actions that are otherwise allowed -> escalate for oversight.
    if (
      decision === "allow" &&
      blastRadius.reversibility === "irreversible" &&
      blastRadius.financialAmount > 0 &&
      req.liability.oversightMode !== "autonomous"
    ) {
      decision = "escalate";
      riskScore = Math.max(riskScore, 0.4);
      citations.push({
        ruleId: "irreversible-oversight",
        pack: "core",
        clause: "blastRadius.reversibility",
        description:
          "Irreversible action under non-autonomous oversight escalated for human confirmation.",
      });
    }

    const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
    return {
      decision,
      tierReached: 1,
      ruleCitations: citations,
      riskScore,
      failMode: null,
      judgeVersion: null,
      latency: {
        totalMs,
        perTier: { "1": totalMs },
        deadlineMs: this.opts.deadlineMs,
        deadlineBreached: totalMs > this.opts.deadlineMs,
      },
    };
  }
}

function readNumericLimit(
  limits: Record<string, unknown> | undefined,
  keys: string[],
): number | null {
  if (!limits) return null;
  for (const k of keys) {
    const v = limits[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}
