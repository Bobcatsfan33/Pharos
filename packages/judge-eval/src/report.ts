import { wilsonInterval, type WilsonInterval } from "@pharos/assurance";
import { type Concern } from "./schema.js";
import { loadConcern } from "./loader.js";
import { type EvalScorer, type ScoreInput } from "./scorer.js";
import { type LabeledScore, confusionAt, ece, f1, pointMetrics, prAuc, rocAuc } from "./metrics.js";
import { bootstrapCI, type CI } from "./bootstrap.js";
import { baseRateBox, type BaseRateBox } from "./baserate.js";

export interface SuiteRecall {
  suite: string;
  lang: string;
  count: number;
  recall: number;
  recallCI: WilsonInterval;
  /** cleanRecall − suiteRecall (positive = degradation). */
  degradationVsClean: number;
}

export interface ControlMetrics {
  name: string;
  cleanRecall: number;
  prAuc: number;
  rocAuc: number;
}

export interface ConcernReport {
  concern: Concern;
  scorer: string;
  threshold: number;
  operatingPointsHash: string;
  clean: {
    positives: number;
    negatives: number;
    prevalence: number;
    precision: number;
    precisionCI: WilsonInterval;
    recall: number;
    recallCI: WilsonInterval;
    fpr: number;
    fprCI: WilsonInterval;
    f1: number;
    f1CI: CI;
    prAuc: number;
    prAucCI: CI;
    rocAuc: number;
    rocAucCI: CI;
    ece: number;
    eceCI: CI;
  };
  hardNegatives: {
    count: number;
    /** How often the model flags a near-miss (compliant) example — the key honesty metric. */
    falsePositiveRate: number;
    falsePositiveRateCI: WilsonInterval;
  };
  adversarial: SuiteRecall[];
  controls: ControlMetrics[];
  baseRate: BaseRateBox;
}

async function scoreSplit(
  scorer: EvalScorer,
  inputs: ScoreInput[],
  labels: (0 | 1)[],
): Promise<LabeledScore[]> {
  const results = await scorer.scoreBatch(inputs);
  return results.map((r, i) => ({ label: labels[i]!, probability: r.probability }));
}

/**
 * Evaluate one scorer for one concern at the frozen threshold, producing the full honest report:
 * clean point metrics + PR/ROC-AUC + ECE with CIs, hard-negative FPR, per-adversarial-suite recall
 * degradation, negative controls, and the base-rate box.
 */
export async function evaluateConcern(
  concern: Concern,
  scorer: EvalScorer,
  threshold: number,
  operatingPointsHash: string,
  opts: {
    seed?: number;
    productionPrevalence?: number | null;
    prevalenceRationale?: string;
    controls?: EvalScorer[];
  } = {},
): Promise<ConcernReport> {
  const seed = opts.seed ?? 12345;
  const { splits } = loadConcern(concern);
  const bySuite = (s: string) => splits.find((x) => x.suite === s)!;

  const posSplit = bySuite("clean-positive");
  const negSplit = bySuite("clean-negative");

  const posScores = await scoreSplit(
    scorer,
    posSplit.examples.map((e) => ({ id: e.id, text: e.text })),
    posSplit.examples.map((e) => e.label),
  );
  const negScored = await scorer.scoreBatch(
    negSplit.examples.map((e) => ({ id: e.id, text: e.text })),
  );
  const negScores: LabeledScore[] = negScored.map((r) => ({
    label: 0,
    probability: r.probability,
  }));

  const clean = [...posScores, ...negScores];
  const pm = pointMetrics(clean, threshold);
  const cCount = confusionAt(clean, threshold);

  // Wilson intervals for the proportion metrics.
  const recallCI = wilsonInterval(cCount.tp, cCount.tp + cCount.fn);
  const precisionCI = wilsonInterval(cCount.tp, cCount.tp + cCount.fp);
  const fprCI = wilsonInterval(cCount.fp, cCount.fp + cCount.tn);

  // Bootstrap intervals for the derived metrics.
  const f1CI = bootstrapCI(clean, f1WrappedAt(threshold), { seed });
  const prAucCI = bootstrapCI(clean, prAuc, { seed: seed + 1 });
  const rocAucCI = bootstrapCI(clean, rocAuc, { seed: seed + 2 });
  const eceCI = bootstrapCI(clean, (s) => ece(s), { seed: seed + 3 });

  // Hard-negative FPR: how often near-misses are flagged.
  const hardNeg = negSplit.examples.filter((e) => e.hardNegative);
  const hardNegScored = await scorer.scoreBatch(hardNeg.map((e) => ({ id: e.id, text: e.text })));
  const hardFp = hardNegScored.filter((r) => r.probability >= threshold).length;
  const hardNegativeFpr = hardNeg.length === 0 ? 0 : hardFp / hardNeg.length;

  // Adversarial suites (obfuscated positives): recall + degradation vs clean.
  const cleanRecall = pm.recall;
  const adversarial: SuiteRecall[] = [];
  for (const split of splits) {
    if (split.suite === "clean-positive" || split.suite === "clean-negative") continue;
    const positives = split.examples.filter((e) => e.label === 1);
    if (positives.length === 0) continue;
    const scored = await scorer.scoreBatch(positives.map((e) => ({ id: e.id, text: e.text })));
    const flagged = scored.filter((r) => r.probability >= threshold).length;
    const rec = flagged / positives.length;
    adversarial.push({
      suite: split.suite,
      lang: split.lang,
      count: positives.length,
      recall: rec,
      recallCI: wilsonInterval(flagged, positives.length),
      degradationVsClean: cleanRecall - rec,
    });
  }

  // Negative controls on the clean set (legible floors).
  const controls: ControlMetrics[] = [];
  for (const control of opts.controls ?? []) {
    const cs = await scoreSplit(
      control,
      [...posSplit.examples, ...negSplit.examples].map((e) => ({ id: e.id, text: e.text })),
      [...posSplit.examples.map((e) => e.label), ...negSplit.examples.map(() => 0 as const)],
    );
    const cc = confusionAt(cs, threshold);
    controls.push({
      name: control.name,
      cleanRecall: cc.tp + cc.fn === 0 ? 0 : cc.tp / (cc.tp + cc.fn),
      prAuc: prAuc(cs),
      rocAuc: rocAuc(cs),
    });
  }

  return {
    concern,
    scorer: scorer.name,
    threshold,
    operatingPointsHash,
    clean: {
      positives: posSplit.count,
      negatives: negSplit.count,
      prevalence: posSplit.count / (posSplit.count + negSplit.count),
      precision: pm.precision,
      precisionCI,
      recall: pm.recall,
      recallCI,
      fpr: pm.fpr,
      fprCI,
      f1: pm.f1,
      f1CI,
      prAuc: prAuc(clean),
      prAucCI,
      rocAuc: rocAuc(clean),
      rocAucCI,
      ece: ece(clean),
      eceCI,
    },
    hardNegatives: {
      count: hardNeg.length,
      falsePositiveRate: hardNegativeFpr,
      falsePositiveRateCI: wilsonInterval(hardFp, hardNeg.length),
    },
    adversarial,
    controls,
    baseRate: baseRateBox(
      posSplit.count / (posSplit.count + negSplit.count),
      pm.recall,
      pm.fpr,
      opts.productionPrevalence ?? null,
      opts.prevalenceRationale ??
        "No defensible deployment prevalence yet; scenarios reported instead of implying balanced-eval precision is operational (§7-10(b)).",
    ),
  };
}

/** Curried F1-at-threshold for the bootstrap. */
function f1WrappedAt(threshold: number): (s: LabeledScore[]) => number {
  return (s) => f1(confusionAt(s, threshold));
}
