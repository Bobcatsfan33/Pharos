/**
 * Classification metrics for the eval harness (roadmap S5-T2).
 *
 * Pure functions over `LabeledScore[]` (a label + a calibrated probability). PR-AUC is the LEAD
 * ranking metric (§7-10(b)); ROC-AUC is secondary context. All deterministic — ties in AUC use
 * average ranks so the number does not depend on input order.
 */
export interface LabeledScore {
  label: 0 | 1;
  probability: number;
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export function confusionAt(scores: LabeledScore[], threshold: number): Confusion {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const s of scores) {
    const pos = s.probability >= threshold;
    if (s.label === 1) {
      if (pos) c.tp++;
      else c.fn++;
    } else {
      if (pos) c.fp++;
      else c.tn++;
    }
  }
  return c;
}

export function precision(c: Confusion): number {
  return c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp);
}
export function recall(c: Confusion): number {
  return c.tp + c.fn === 0 ? 0 : c.tp / (c.tp + c.fn);
}
export function f1(c: Confusion): number {
  const p = precision(c);
  const r = recall(c);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}
/** False-positive rate = fp / (fp + tn). */
export function fpr(c: Confusion): number {
  return c.fp + c.tn === 0 ? 0 : c.fp / (c.fp + c.tn);
}

/**
 * Average precision (PR-AUC) via the step-wise sum Σ (R_k − R_{k−1})·P_k over descending scores.
 * Robust to class imbalance — the reason it leads ROC-AUC for rare-positive detection.
 */
export function prAuc(scores: LabeledScore[]): number {
  const nPos = scores.filter((s) => s.label === 1).length;
  if (nPos === 0) return 0;
  const sorted = [...scores].sort((a, b) => b.probability - a.probability);
  let tp = 0;
  let fp = 0;
  let prevRecall = 0;
  let ap = 0;
  let i = 0;
  while (i < sorted.length) {
    // Consume all items at this probability together (ties share a threshold).
    const p = sorted[i]!.probability;
    while (i < sorted.length && sorted[i]!.probability === p) {
      if (sorted[i]!.label === 1) tp++;
      else fp++;
      i++;
    }
    const rec = tp / nPos;
    const prec = tp + fp === 0 ? 0 : tp / (tp + fp);
    ap += (rec - prevRecall) * prec;
    prevRecall = rec;
  }
  return ap;
}

/** ROC-AUC via the Mann–Whitney U statistic with average ranks for ties. Deterministic. */
export function rocAuc(scores: LabeledScore[]): number {
  const nPos = scores.filter((s) => s.label === 1).length;
  const nNeg = scores.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  const sorted = [...scores].sort((a, b) => a.probability - b.probability);
  // Assign average ranks (1-based).
  const ranks = new Array(sorted.length).fill(0);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j]!.probability === sorted[i]!.probability) j++;
    const avg = (i + 1 + j) / 2; // average of ranks (i+1)..j
    for (let k = i; k < j; k++) ranks[k] = avg;
    i = j;
  }
  let sumPosRanks = 0;
  for (let k = 0; k < sorted.length; k++) if (sorted[k]!.label === 1) sumPosRanks += ranks[k];
  return (sumPosRanks - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/**
 * Expected Calibration Error over `bins` equal-width probability bins:
 * Σ (n_b / N) · |accuracy_b − confidence_b|.
 */
export function ece(scores: LabeledScore[], bins = 10): number {
  if (scores.length === 0) return 0;
  const counts = new Array(bins).fill(0);
  const conf = new Array(bins).fill(0);
  const acc = new Array(bins).fill(0);
  for (const s of scores) {
    let b = Math.floor(s.probability * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    counts[b]++;
    conf[b] += s.probability;
    acc[b] += s.label;
  }
  let e = 0;
  for (let b = 0; b < bins; b++) {
    if (counts[b] === 0) continue;
    const avgConf = conf[b] / counts[b];
    const avgAcc = acc[b] / counts[b];
    e += (counts[b] / scores.length) * Math.abs(avgAcc - avgConf);
  }
  return e;
}

export interface PointMetrics {
  threshold: number;
  confusion: Confusion;
  precision: number;
  recall: number;
  f1: number;
  fpr: number;
}

export function pointMetrics(scores: LabeledScore[], threshold: number): PointMetrics {
  const c = confusionAt(scores, threshold);
  return {
    threshold,
    confusion: c,
    precision: precision(c),
    recall: recall(c),
    f1: f1(c),
    fpr: fpr(c),
  };
}
