import {
  type ActionIntent,
  type LiabilityContext,
  type VerdictContext,
  type RuleCitation,
} from "../schema/actionRecord.js";
import type { PublicKeyEntry } from "../signing/provider.js";
import { applyMandateToken } from "../mandate-token/bind.js";
import { scopeAllowsActionType } from "../mandate-token/codec.js";
import type { MandateToken } from "../mandate-token/types.js";

/**
 * The verdict request: an agent action plus the liability context that governs it.
 * This is the single ingestion shape — the same request that yields a verdict yields
 * the sealed evidence record.
 */
export interface VerdictRequest {
  tenantId: string;
  action: ActionIntent;
  liability: LiabilityContext;
  /**
   * A presented MandateToken (Workstream A) and the published root key it names (`null` when
   * the key is unknown). Resolved into `liability` by {@link resolveVerdictRequest} before any
   * rule runs: a verified token supersedes the server-side mandate; a refused one is sealed with
   * its reason and blocked at Tier 1.
   */
  mandateToken?: {
    token: MandateToken;
    rootKey: PublicKeyEntry | null;
    /** Server-side knowledge an offline verifier lacks. */
    revoked?: boolean;
  };
}

/**
 * Fold a presented token into the liability the cascade sees and seals. Idempotent: a request
 * whose liability already carries `mandateToken` (a replay) is returned as is.
 */
export function resolveVerdictRequest(req: VerdictRequest, now: Date): VerdictRequest {
  if (!req.mandateToken || req.liability.mandateToken) {
    if (!req.mandateToken) return req;
    const { mandateToken: _raw, ...rest } = req;
    return rest;
  }
  const { mandateToken, ...rest } = req;
  return {
    ...rest,
    liability: applyMandateToken(req.liability, mandateToken.token, mandateToken.rootKey, now, {
      expect: { tenantId: req.tenantId, agentId: req.action.agentId },
      revoked: mandateToken.revoked,
    }),
  };
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

  evaluate(rawReq: VerdictRequest, now: Date): VerdictContext {
    const start = process.hrtime.bigint();
    const citations: RuleCitation[] = [];
    let decision: VerdictContext["decision"] = "allow";
    let riskScore = 0;

    const req = resolveVerdictRequest(rawReq, now);
    const { mandate, blastRadius, mandateToken } = req.liability;

    // Rule: a presented MandateToken that did not verify -> block. Structural, not policy: the
    // reason is sealed in liability.mandateToken.verification, so replay blocks identically.
    if (mandateToken && mandateToken.verification !== "verified") {
      decision = "block";
      riskScore = 1;
      citations.push({
        ruleId: "mandate-token-invalid",
        pack: "core",
        clause: "liability.mandateToken.verification",
        description: `Presented mandate token was refused: ${mandateToken.verification}.`,
      });
    }

    // Rule: the action type is outside the token's effective scope -> block.
    if (
      mandateToken?.verification === "verified" &&
      mandateToken.effective &&
      !scopeAllowsActionType(mandateToken.effective.scope, req.action.type)
    ) {
      decision = "block";
      riskScore = 1;
      citations.push({
        ruleId: "mandate-token-scope",
        pack: "core",
        clause: "liability.mandateToken.effective.scope.actionTypes",
        description: `Action type "${req.action.type}" is outside the token's effective scope [${mandateToken.effective.scope.actionTypes.join(", ")}].`,
      });
    }

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
