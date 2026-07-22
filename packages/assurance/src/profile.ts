import { type WilsonInterval } from "./wilson.js";

/**
 * Risk profile v2 — the unified posture metrics recomputed from sealed records plus Beam-side
 * signals (escalation, disagreement, assurance bound). Continuous scoring; trend history is
 * the time series of these snapshots.
 */
export interface RecordSummary {
  decision: "allow" | "block" | "modify" | "escalate";
  oversightMode: "autonomous" | "human_in_loop" | "human_on_loop";
  reversibility: "reversible" | "irreversible";
  financialAmount: number;
  failMode: "fail_open" | "fail_closed" | null;
  mandatePresent: boolean;
}

export interface RiskProfileV2 {
  records: number;
  // Posture (Ledger).
  autonomyRate: number;
  irreversibleMix: number;
  policyFailureRate: number;
  avgBlastRadius: number;
  maxBlastRadius: number;
  oversightCoverage: number;
  // Beam-side signals.
  escalationRate: number;
  blockRate: number;
  disagreementRate: number;
  assuranceLowerBound: number;
  // Composite (0–100; higher = riskier).
  compositeRisk: number;
  grade: "A" | "B" | "C" | "D";
}

function rate(n: number, total: number): number {
  return total === 0 ? 0 : n / total;
}

export function computeRiskProfile(
  records: RecordSummary[],
  assurance: WilsonInterval,
  disagreementRate: number,
): RiskProfileV2 {
  const total = records.length;
  let autonomous = 0,
    irreversible = 0,
    failures = 0,
    oversight = 0,
    escalate = 0,
    block = 0,
    sumBlast = 0,
    maxBlast = 0;
  for (const r of records) {
    if (r.oversightMode === "autonomous") autonomous += 1;
    else oversight += 1;
    if (r.reversibility === "irreversible") irreversible += 1;
    if (r.failMode) failures += 1;
    if (r.decision === "escalate") escalate += 1;
    if (r.decision === "block") block += 1;
    sumBlast += r.financialAmount;
    if (r.financialAmount > maxBlast) maxBlast = r.financialAmount;
  }

  const autonomyRate = rate(autonomous, total);
  const irreversibleMix = rate(irreversible, total);
  const policyFailureRate = rate(failures, total);
  const oversightCoverage = rate(oversight, total);
  const escalationRate = rate(escalate, total);
  const blockRate = rate(block, total);

  // Composite: autonomy + irreversible mix + failures + low assurance push risk up;
  // oversight coverage pulls it down. Weighted to 0–100.
  const raw =
    autonomyRate * 25 +
    irreversibleMix * 20 +
    policyFailureRate * 20 +
    disagreementRate * 15 +
    (1 - assurance.lower) * 20 -
    oversightCoverage * 15;
  const compositeRisk = Math.max(0, Math.min(100, Math.round(raw + 15)));

  const grade: RiskProfileV2["grade"] =
    compositeRisk < 25 ? "A" : compositeRisk < 45 ? "B" : compositeRisk < 65 ? "C" : "D";

  return {
    records: total,
    autonomyRate,
    irreversibleMix,
    policyFailureRate,
    avgBlastRadius: rate(sumBlast, total),
    maxBlastRadius: maxBlast,
    oversightCoverage,
    escalationRate,
    blockRate,
    disagreementRate,
    assuranceLowerBound: assurance.lower,
    compositeRisk,
    grade,
  };
}
