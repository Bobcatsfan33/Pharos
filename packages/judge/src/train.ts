import { sha256Hex } from "@pharos/core";
import { featureCounts } from "./featurize.js";
import { type JudgeModelArtifact } from "./model.js";

export interface LabeledExample {
  text: string;
  label: 0 | 1;
}

export interface TrainOptions {
  packId: string;
  concern: string;
  iterations?: number;
  learningRate?: number;
  l2?: number;
  threshold?: number;
}

/**
 * Train a binary logistic-regression judge by full-batch gradient descent.
 *
 * Deterministic by construction: weights initialize to zero, the gradient is computed over
 * the full dataset each step, and there is no randomness — so the same dataset always
 * produces the same artifact (and the same model version). This is what makes Tier-3
 * verdicts reproducible.
 */
export function trainJudge(examples: LabeledExample[], opts: TrainOptions): JudgeModelArtifact {
  const iterations = opts.iterations ?? 300;
  const lr = opts.learningRate ?? 0.5;
  const l2 = opts.l2 ?? 0.0005;

  // Pre-compute feature counts per example and the vocabulary (sorted for determinism).
  const counts = examples.map((e) => featureCounts(e.text));
  const vocabSet = new Set<string>();
  for (const c of counts) for (const f of c.keys()) vocabSet.add(f);
  const vocab = [...vocabSet].sort();

  const weights = new Map<string, number>(vocab.map((v) => [v, 0]));
  let bias = 0;
  const n = examples.length || 1;

  const sigmoid = (z: number) =>
    z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

  for (let iter = 0; iter < iterations; iter++) {
    const gradW = new Map<string, number>(vocab.map((v) => [v, 0]));
    let gradB = 0;
    for (let i = 0; i < examples.length; i++) {
      let z = bias;
      const c = counts[i]!;
      for (const [f, cnt] of c) z += (weights.get(f) ?? 0) * cnt;
      const pred = sigmoid(z);
      const err = pred - examples[i]!.label;
      gradB += err;
      for (const [f, cnt] of c) gradW.set(f, (gradW.get(f) ?? 0) + err * cnt);
    }
    bias -= lr * (gradB / n);
    for (const f of vocab) {
      const g = (gradW.get(f) ?? 0) / n + l2 * (weights.get(f) ?? 0);
      weights.set(f, (weights.get(f) ?? 0) - lr * g);
    }
  }

  // Drop near-zero weights to keep the artifact compact and stable.
  const prunedWeights: Record<string, number> = {};
  for (const f of vocab) {
    const w = weights.get(f) ?? 0;
    if (Math.abs(w) > 1e-4) prunedWeights[f] = Number(w.toFixed(6));
  }

  const positives = examples.filter((e) => e.label === 1).length;
  return {
    packId: opts.packId,
    concern: opts.concern,
    weights: prunedWeights,
    bias: Number(bias.toFixed(6)),
    threshold: opts.threshold ?? 0.5,
    trainedOn: {
      examples: examples.length,
      positives,
      datasetHash: sha256Hex(examples).slice(0, 16),
      iterations,
    },
  };
}
