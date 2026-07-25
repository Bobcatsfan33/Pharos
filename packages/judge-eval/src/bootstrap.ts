import { mulberry32 } from "./prng.js";
import type { LabeledScore } from "./metrics.js";

/**
 * Deterministic seeded stratified bootstrap confidence intervals (roadmap §7-10(c)).
 *
 * Wilson intervals cover simple binomial proportions (recall, precision); for DERIVED metrics
 * (F1, PR-AUC, ROC-AUC, ECE, recall degradation) where Wilson does not apply, we resample the
 * labeled scores WITH REPLACEMENT, stratified by label so prevalence is preserved, and take
 * percentile bounds. Seeded, so the interval is reproducible.
 */
export interface CI {
  point: number;
  lower: number;
  upper: number;
  resamples: number;
}

export const DEFAULT_RESAMPLES = 1000;

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** One stratified resample (positives and negatives resampled within their own strata). */
function resample(scores: LabeledScore[], rng: () => number): LabeledScore[] {
  const pos = scores.filter((s) => s.label === 1);
  const neg = scores.filter((s) => s.label === 0);
  const out: LabeledScore[] = [];
  for (let i = 0; i < pos.length; i++) out.push(pos[Math.floor(rng() * pos.length)]!);
  for (let i = 0; i < neg.length; i++) out.push(neg[Math.floor(rng() * neg.length)]!);
  return out;
}

export function bootstrapCI(
  scores: LabeledScore[],
  stat: (s: LabeledScore[]) => number,
  opts: { seed: number; resamples?: number; confidence?: number } = { seed: 1 },
): CI {
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const confidence = opts.confidence ?? 0.95;
  const rng = mulberry32(opts.seed);
  const stats: number[] = [];
  for (let i = 0; i < resamples; i++) stats.push(stat(resample(scores, rng)));
  stats.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    point: stat(scores),
    lower: percentile(stats, alpha),
    upper: percentile(stats, 1 - alpha),
    resamples,
  };
}

/**
 * Paired stratified bootstrap of a delta between two scorers over the SAME records (roadmap
 * S5-T4). Both scorers' per-record scores are resampled with the SAME indices each round, so the
 * pairing is preserved. Returns the delta CI (candidate − baseline).
 */
export function pairedBootstrapDeltaCI(
  baseline: LabeledScore[],
  candidate: LabeledScore[],
  stat: (s: LabeledScore[]) => number,
  opts: { seed: number; resamples?: number; confidence?: number } = { seed: 1 },
): CI {
  if (baseline.length !== candidate.length) {
    throw new Error("paired bootstrap requires aligned baseline/candidate arrays");
  }
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const confidence = opts.confidence ?? 0.95;
  const rng = mulberry32(opts.seed);
  const posIdx = baseline.map((s, i) => (s.label === 1 ? i : -1)).filter((i) => i >= 0);
  const negIdx = baseline.map((s, i) => (s.label === 0 ? i : -1)).filter((i) => i >= 0);
  const deltas: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const idx: number[] = [];
    for (let i = 0; i < posIdx.length; i++) idx.push(posIdx[Math.floor(rng() * posIdx.length)]!);
    for (let i = 0; i < negIdx.length; i++) idx.push(negIdx[Math.floor(rng() * negIdx.length)]!);
    const b = idx.map((i) => baseline[i]!);
    const c = idx.map((i) => candidate[i]!);
    deltas.push(stat(c) - stat(b));
  }
  deltas.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    point: stat(candidate) - stat(baseline),
    lower: percentile(deltas, alpha),
    upper: percentile(deltas, 1 - alpha),
    resamples,
  };
}
