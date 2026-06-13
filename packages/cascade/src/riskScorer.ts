import type { VerdictRequest } from "@pharos/core";

/**
 * Tier 2 — statistical risk scoring.
 *
 * A transparent, deterministic weighted-feature score in [0,1] derived from the action's
 * liability shape: financial magnitude (log-scaled), irreversibility, oversight mode,
 * mandate presence, and action-class sensitivity. Deterministic so the same inputs always
 * yield the same risk (a requirement for reproducible verdicts).
 */
export interface RiskBreakdown {
  score: number;
  components: Record<string, number>;
}

const SENSITIVE_ACTION_TYPES = new Set([
  "payment.transfer",
  "funds.move",
  "wire.send",
  "data.export",
  "record.export",
  "account.close",
  "key.rotate",
]);

export function scoreRisk(req: VerdictRequest): RiskBreakdown {
  const { blastRadius, oversightMode, mandate } = req.liability;
  const components: Record<string, number> = {};

  // Financial magnitude on a log scale: ~$1M maps toward 1.0.
  const amount = Math.max(0, blastRadius.financialAmount);
  components.financial = clamp01((Math.log10(1 + amount) / 6) * 0.5);

  components.irreversible = blastRadius.reversibility === "irreversible" ? 0.25 : 0;
  components.autonomy = oversightMode === "autonomous" ? 0.1 : 0;
  components.noMandate = mandate === null ? 0.1 : 0;
  components.sensitiveAction = SENSITIVE_ACTION_TYPES.has(req.action.type) ? 0.2 : 0;

  const score = clamp01(Object.values(components).reduce((a, b) => a + b, 0));
  return { score, components };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
