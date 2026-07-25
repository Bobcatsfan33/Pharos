import { type JudgeModelArtifact, score as scoreLogistic } from "@pharos/judge";
import { mulberry32 } from "./prng.js";

/**
 * Async, batchable scorer contract (roadmap S5-T2 / §7-10(f)).
 *
 * Sprint 6's served ONNX judge is async; today's logistic judge is synchronous. The harness only
 * ever calls `scoreBatch`, so a served transformer can plug in with no harness rewrite. Batch size
 * is configurable. Output order MUST match input order.
 */
export interface ScoreInput {
  id: string;
  text: string;
}

export interface ScoredResult {
  id: string;
  probability: number;
}

export interface EvalScorer {
  name: string;
  scoreBatch(inputs: ScoreInput[], batchSize?: number): Promise<ScoredResult[]>;
}

/** Adapt today's synchronous in-process logistic judge to the async batched contract. */
export function logisticScorer(artifact: JudgeModelArtifact): EvalScorer {
  return {
    name: `logistic:${artifact.packId}`,
    async scoreBatch(inputs, batchSize = 64): Promise<ScoredResult[]> {
      const out: ScoredResult[] = [];
      for (let i = 0; i < inputs.length; i += batchSize) {
        const batch = inputs.slice(i, i + batchSize);
        // Await a resolved microtask per batch so async back-pressure is real, not simulated.
        await Promise.resolve();
        for (const inp of batch)
          out.push({ id: inp.id, probability: scoreLogistic(artifact, inp.text) });
      }
      return out;
    },
  };
}

/** Negative control: always emits a constant probability (used for the majority-class floor). */
export function constantScorer(name: string, probability: number): EvalScorer {
  return {
    name,
    async scoreBatch(inputs) {
      return inputs.map((i) => ({ id: i.id, probability }));
    },
  };
}

/**
 * Negative control: deterministic pseudo-random probability per input (seeded by id), giving a
 * legible chance-level floor (ROC-AUC ≈ 0.5). Not `Math.random` — reproducible.
 */
export function seededRandomScorer(name: string, seed: number): EvalScorer {
  return {
    name,
    async scoreBatch(inputs) {
      return inputs.map((i) => {
        // Fold the id into the seed so the "random" score is stable per record.
        let h = seed >>> 0;
        for (let k = 0; k < i.id.length; k++) h = (Math.imul(h, 31) + i.id.charCodeAt(k)) >>> 0;
        return { id: i.id, probability: mulberry32(h)() };
      });
    },
  };
}
