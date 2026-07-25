import { describe, it, expect } from "vitest";
import {
  type LabeledScore,
  confusionAt,
  precision,
  recall,
  f1,
  fpr,
  prAuc,
  rocAuc,
  ece,
  bootstrapCI,
  pairedBootstrapDeltaCI,
  adjustedPrecision,
  logisticScorer,
  constantScorer,
  seededRandomScorer,
  loadOperatingPoints,
  operatingPointsHash,
} from "@pharos/judge-eval";

const S: LabeledScore[] = [
  { label: 1, probability: 0.9 },
  { label: 1, probability: 0.4 },
  { label: 0, probability: 0.6 },
  { label: 0, probability: 0.1 },
];

describe("metrics", () => {
  it("confusion + precision/recall/f1/fpr at a threshold", () => {
    const c = confusionAt(S, 0.5);
    expect(c).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(precision(c)).toBeCloseTo(0.5, 6);
    expect(recall(c)).toBeCloseTo(0.5, 6);
    expect(f1(c)).toBeCloseTo(0.5, 6);
    expect(fpr(c)).toBeCloseTo(0.5, 6);
  });

  it("ROC-AUC via rank-sum (with average ranks for ties)", () => {
    expect(rocAuc(S)).toBeCloseTo(0.75, 6);
    // Perfect separation → 1.0; inverted → 0.0.
    expect(
      rocAuc([
        { label: 1, probability: 0.9 },
        { label: 0, probability: 0.1 },
      ]),
    ).toBeCloseTo(1, 6);
    // All-tied scores → 0.5 (chance).
    expect(
      rocAuc([
        { label: 1, probability: 0.5 },
        { label: 0, probability: 0.5 },
      ]),
    ).toBeCloseTo(0.5, 6);
  });

  it("PR-AUC (average precision) is order-independent and imbalance-aware", () => {
    expect(prAuc(S)).toBeCloseTo(0.8333, 3);
    expect(prAuc([...S].reverse())).toBeCloseTo(0.8333, 3);
    expect(
      prAuc([
        { label: 1, probability: 0.9 },
        { label: 0, probability: 0.1 },
      ]),
    ).toBeCloseTo(1, 6);
  });

  it("ECE is 0 for perfectly-calibrated bins and within [0,1]", () => {
    // Two records at prob 1.0 with label 1, two at 0.0 with label 0 → perfectly calibrated.
    const cal: LabeledScore[] = [
      { label: 1, probability: 1 },
      { label: 1, probability: 1 },
      { label: 0, probability: 0 },
      { label: 0, probability: 0 },
    ];
    expect(ece(cal)).toBeCloseTo(0, 6);
    expect(ece(S)).toBeGreaterThanOrEqual(0);
    expect(ece(S)).toBeLessThanOrEqual(1);
  });
});

describe("bootstrap CIs", () => {
  it("are deterministic for a fixed seed and bracket the point estimate", () => {
    const big: LabeledScore[] = Array.from({ length: 200 }, (_, i) => ({
      label: (i % 2) as 0 | 1,
      probability: i % 2 === 1 ? 0.7 : 0.3,
    }));
    const a = bootstrapCI(big, rocAuc, { seed: 7 });
    const b = bootstrapCI(big, rocAuc, { seed: 7 });
    expect(a).toEqual(b); // same seed → identical interval
    expect(a.lower).toBeLessThanOrEqual(a.point);
    expect(a.upper).toBeGreaterThanOrEqual(a.point);
  });

  it("paired delta bootstrap is zero-centered when both scorers are identical", () => {
    const base = S;
    const cand = S.map((s) => ({ ...s }));
    const d = pairedBootstrapDeltaCI(base, cand, rocAuc, { seed: 3 });
    expect(d.point).toBeCloseTo(0, 6);
    expect(d.lower).toBeLessThanOrEqual(0);
    expect(d.upper).toBeGreaterThanOrEqual(0);
  });
});

describe("base-rate adjustment", () => {
  it("adjusts precision for production prevalence", () => {
    // recall 1.0, fpr 0.1, prevalence 1% → PPV = .01 / (.01 + .1*.99) ≈ 9.2%.
    expect(adjustedPrecision(1.0, 0.1, 0.01)).toBeCloseTo(0.0917, 3);
    // Balanced (50%) with recall 1, fpr 0 → 100%.
    expect(adjustedPrecision(1.0, 0.0, 0.5)).toBeCloseTo(1, 6);
  });
});

describe("scorer contract", () => {
  it("logistic adapter preserves order regardless of batch size", async () => {
    const artifact = {
      packId: "t",
      concern: "t",
      weights: { "u:guaranteed": 5 },
      bias: -1,
      threshold: 0.5,
      trainedOn: { examples: 0, positives: 0, datasetHash: "x", iterations: 0 },
    };
    const scorer = logisticScorer(artifact);
    const inputs = [
      { id: "a", text: "guaranteed guaranteed" },
      { id: "b", text: "nothing here" },
      { id: "c", text: "guaranteed" },
    ];
    const r1 = await scorer.scoreBatch(inputs, 1);
    const r64 = await scorer.scoreBatch(inputs, 64);
    expect(r1.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(r1).toEqual(r64); // batch size must not change results or order
  });

  it("control scorers: constant and seeded-random (deterministic)", async () => {
    const inputs = [
      { id: "a", text: "x" },
      { id: "b", text: "y" },
    ];
    expect(
      (await constantScorer("k", 1).scoreBatch(inputs)).every((r) => r.probability === 1),
    ).toBe(true);
    const rnd = seededRandomScorer("r", 42);
    expect(await rnd.scoreBatch(inputs)).toEqual(await rnd.scoreBatch(inputs));
  });
});

describe("frozen operating points", () => {
  it("load with a stable content hash and 0.5 thresholds", () => {
    const op = loadOperatingPoints();
    expect(op.points.thresholds["finra-promissory"]).toBe(0.5);
    expect(op.hash).toBe(operatingPointsHash(op.points));
    expect(op.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
