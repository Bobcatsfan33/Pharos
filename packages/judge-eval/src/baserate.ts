/**
 * Base-rate honesty (roadmap §7-10(b)).
 *
 * Precision on a balanced eval set is NOT operational precision. Given a model's recall (TPR) and
 * false-positive rate (FPR) — both prevalence-independent — the precision (PPV) you would see in
 * production at a given positive prevalence is:
 *
 *   PPV = (recall · p) / (recall · p + fpr · (1 − p))
 *
 * When no deployment prevalence is defensible, report scenarios rather than implying the eval
 * precision is operational.
 */
export const PREVALENCE_SCENARIOS: readonly number[] = [0.001, 0.01, 0.05, 0.1];

export function adjustedPrecision(recall: number, fpr: number, prevalence: number): number {
  const tp = recall * prevalence;
  const fp = fpr * (1 - prevalence);
  return tp + fp === 0 ? 0 : tp / (tp + fp);
}

export interface BaseRateBox {
  evalPrevalence: number;
  /** Cited/assumed production prevalence, or null when none is defensible. */
  productionPrevalence: number | null;
  productionPrevalenceRationale: string;
  /** Adjusted precision at the production prevalence (if set). */
  adjustedPrecision: number | null;
  /** Adjusted precision at each scenario prevalence (always reported). */
  scenarios: Array<{ prevalence: number; adjustedPrecision: number }>;
}

export function baseRateBox(
  evalPrevalence: number,
  recall: number,
  fpr: number,
  productionPrevalence: number | null,
  rationale: string,
): BaseRateBox {
  return {
    evalPrevalence,
    productionPrevalence,
    productionPrevalenceRationale: rationale,
    adjustedPrecision:
      productionPrevalence === null ? null : adjustedPrecision(recall, fpr, productionPrevalence),
    scenarios: PREVALENCE_SCENARIOS.map((p) => ({
      prevalence: p,
      adjustedPrecision: adjustedPrecision(recall, fpr, p),
    })),
  };
}
