import { sha256Hex } from "@pharos/core";
import { featureCounts } from "./featurize.js";

/**
 * A served distilled-judge model: a binary logistic classifier over text features for one
 * domain concern (e.g. FINRA promissory language, PHI-in-context, funds-movement intent).
 *
 * This is the sub-1B-class "small model" the cascade serves at Tier 3 — here a compact,
 * CPU-feasible linear model whose weights are learned from labeled data. The interface
 * (featurize → score → calibrated probability) is identical to what a transformer judge
 * would expose, so the served model can be upgraded without changing the cascade.
 */
export interface JudgeModelArtifact {
  packId: string;
  /** Human label of the concern this model scores. */
  concern: string;
  /** Learned feature weights. */
  weights: Record<string, number>;
  bias: number;
  /** Decision threshold on the calibrated probability. */
  threshold: number;
  /** Trainer metadata for provenance. */
  trainedOn: { examples: number; positives: number; datasetHash: string; iterations: number };
}

export interface JudgeResult {
  packId: string;
  concern: string;
  judgeVersion: string;
  probability: number;
  flagged: boolean;
  threshold: number;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * The model version is the content hash of the artifact (excluding the version itself):
 * `<packId>@<sha256[:12]>`. Every verdict cites the exact judge version that produced it,
 * and an artifact cannot change without changing its version.
 */
export function modelVersion(artifact: JudgeModelArtifact): string {
  const hash = sha256Hex({
    packId: artifact.packId,
    concern: artifact.concern,
    weights: artifact.weights,
    bias: artifact.bias,
    threshold: artifact.threshold,
  });
  return `${artifact.packId}@${hash.slice(0, 12)}`;
}

export function score(artifact: JudgeModelArtifact, text: string): number {
  let z = artifact.bias;
  for (const [feature, count] of featureCounts(text)) {
    const w = artifact.weights[feature];
    if (w !== undefined) z += w * count;
  }
  return sigmoid(z);
}

export function judge(artifact: JudgeModelArtifact, text: string): JudgeResult {
  const probability = score(artifact, text);
  return {
    packId: artifact.packId,
    concern: artifact.concern,
    judgeVersion: modelVersion(artifact),
    probability,
    flagged: probability >= artifact.threshold,
    threshold: artifact.threshold,
  };
}
