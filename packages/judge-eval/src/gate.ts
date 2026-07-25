import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@pharos/core";
import { type Concern } from "./schema.js";
import { loadConcern } from "./loader.js";
import { DATA_DIR } from "./loader.js";
import { type EvalScorer } from "./scorer.js";
import { type LabeledScore, confusionAt, ece, fpr, prAuc, recall } from "./metrics.js";
import { pairedBootstrapDeltaCI, type CI } from "./bootstrap.js";

/**
 * The statistically-meaningful CI eval gate (roadmap S5-T4 / §7-10(c)).
 *
 * Compares a CANDIDATE scorer against a FROZEN baseline over the same records, per sliced metric,
 * at the frozen threshold. Each metric's candidate−baseline delta gets a deterministic paired
 * stratified-bootstrap 95% interval. A metric FAILS only when the ENTIRE interval is worse than its
 * committed tolerance — never on point-estimate noise. Every slice (clean recall/precision, PR-AUC,
 * ECE, hard-negative FPR, and each adversarial suite recall) is gated, so an aggregate gain cannot
 * hide a sliced regression.
 */
export type Direction = "higher" | "lower";

export interface Tolerances {
  schemaVersion: string;
  metrics: Record<string, { direction: Direction; tolerance: number }>;
}

export function loadTolerances(): Tolerances {
  return JSON.parse(readFileSync(join(DATA_DIR, "eval-tolerances.json"), "utf8")) as Tolerances;
}

export interface MetricVerdict {
  concern: Concern;
  metric: string;
  suite?: string;
  direction: Direction;
  tolerance: number;
  baseline: number;
  candidate: number;
  delta: number;
  deltaCI: CI;
  pass: boolean;
}

export interface GateResult {
  pass: boolean;
  operatingPointsHash: string;
  baselineHash: string;
  verdicts: MetricVerdict[];
}

/** A metric fails only when the whole delta interval is on the wrong side of the tolerance. */
function isFail(direction: Direction, tolerance: number, ci: CI): boolean {
  // higher-is-better: worse = smaller delta; entirely-worse ⇒ upper bound below tolerance.
  if (direction === "higher") return ci.upper < tolerance;
  // lower-is-better: worse = larger delta; entirely-worse ⇒ lower bound above tolerance.
  return ci.lower > tolerance;
}

async function scores(
  scorer: EvalScorer,
  texts: { id: string; text: string }[],
  labels: (0 | 1)[],
): Promise<LabeledScore[]> {
  const r = await scorer.scoreBatch(texts);
  return r.map((x, i) => ({ label: labels[i]!, probability: x.probability }));
}

const STAT = {
  recall: (s: LabeledScore[], t: number) => recall(confusionAt(s, t)),
  fpr: (s: LabeledScore[], t: number) => fpr(confusionAt(s, t)),
  precision: (s: LabeledScore[], t: number) => {
    const c = confusionAt(s, t);
    return c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp);
  },
  prAuc: (s: LabeledScore[]) => prAuc(s),
  ece: (s: LabeledScore[]) => ece(s),
};

/** Evaluate the gate for one concern. Returns one verdict per gated metric slice. */
export async function gateConcern(
  concern: Concern,
  baseline: EvalScorer,
  candidate: EvalScorer,
  threshold: number,
  tol: Tolerances,
  seed = 999,
  resamples?: number,
): Promise<MetricVerdict[]> {
  const { splits } = loadConcern(concern);
  const bySuite = (s: string) => splits.find((x) => x.suite === s)!;
  const verdicts: MetricVerdict[] = [];

  // Clean slice: recall, precision, PR-AUC, ECE.
  const cleanEx = [...bySuite("clean-positive").examples, ...bySuite("clean-negative").examples];
  const cleanTexts = cleanEx.map((e) => ({ id: e.id, text: e.text }));
  const cleanLabels = cleanEx.map((e) => e.label);
  const baseClean = await scores(baseline, cleanTexts, cleanLabels);
  const candClean = await scores(candidate, cleanTexts, cleanLabels);

  const cleanMetrics: Array<[string, (s: LabeledScore[]) => number, string]> = [
    ["clean-recall", (s) => STAT.recall(s, threshold), "clean-recall"],
    ["clean-precision", (s) => STAT.precision(s, threshold), "clean-precision"],
    ["pr-auc", STAT.prAuc, "pr-auc"],
    ["ece", STAT.ece, "ece"],
  ];
  let seedN = seed;
  for (const [metric, stat, key] of cleanMetrics) {
    const spec = tol.metrics[key]!;
    const ci = pairedBootstrapDeltaCI(baseClean, candClean, stat, { seed: seedN++, resamples });
    const v: MetricVerdict = {
      concern,
      metric,
      direction: spec.direction,
      tolerance: spec.tolerance,
      baseline: stat(baseClean),
      candidate: stat(candClean),
      delta: ci.point,
      deltaCI: ci,
      pass: !isFail(spec.direction, spec.tolerance, ci),
    };
    verdicts.push(v);
  }

  // Hard-negative FPR slice.
  const hardEx = bySuite("clean-negative").examples.filter((e) => e.hardNegative);
  const hardTexts = hardEx.map((e) => ({ id: e.id, text: e.text }));
  const hardLabels = hardEx.map(() => 0 as const);
  const baseHard = await scores(baseline, hardTexts, hardLabels);
  const candHard = await scores(candidate, hardTexts, hardLabels);
  {
    const spec = tol.metrics["hard-negative-fpr"]!;
    const stat = (s: LabeledScore[]) => STAT.fpr(s, threshold);
    const ci = pairedBootstrapDeltaCI(baseHard, candHard, stat, { seed: seedN++, resamples });
    verdicts.push({
      concern,
      metric: "hard-negative-fpr",
      direction: spec.direction,
      tolerance: spec.tolerance,
      baseline: stat(baseHard),
      candidate: stat(candHard),
      delta: ci.point,
      deltaCI: ci,
      pass: !isFail(spec.direction, spec.tolerance, ci),
    });
  }

  // Each adversarial suite recall.
  const advSpec = tol.metrics["adversarial-recall"]!;
  for (const split of splits) {
    if (split.suite === "clean-positive" || split.suite === "clean-negative") continue;
    const positives = split.examples.filter((e) => e.label === 1);
    if (positives.length === 0) continue;
    const texts = positives.map((e) => ({ id: e.id, text: e.text }));
    const labels = positives.map(() => 1 as const);
    const b = await scores(baseline, texts, labels);
    const c = await scores(candidate, texts, labels);
    const stat = (s: LabeledScore[]) => STAT.recall(s, threshold);
    const ci = pairedBootstrapDeltaCI(b, c, stat, { seed: seedN++, resamples });
    verdicts.push({
      concern,
      metric: "adversarial-recall",
      suite: split.suite,
      direction: advSpec.direction,
      tolerance: advSpec.tolerance,
      baseline: stat(b),
      candidate: stat(c),
      delta: ci.point,
      deltaCI: ci,
      pass: !isFail(advSpec.direction, advSpec.tolerance, ci),
    });
  }

  return verdicts;
}

export interface BaselineLock {
  operatingPointsHash: string;
  artifactHashes: Record<string, string>;
}

export function baselineModelsDir(): string {
  return join(DATA_DIR, "baseline-models");
}

/** sha256 of a frozen baseline artifact (for the lock check). */
export function artifactHash(concern: Concern): string {
  const raw = readFileSync(join(baselineModelsDir(), `${concern}.model.json`), "utf8");
  return sha256Hex(JSON.parse(raw));
}

export function loadBaselineLock(): BaselineLock {
  return JSON.parse(readFileSync(join(baselineModelsDir(), "lock.json"), "utf8")) as BaselineLock;
}

/**
 * Validate, BEFORE any comparison, that the frozen baseline artifacts and the operating points are
 * exactly what the lock records (§7-10 AC: baseline + operating-point manifest content-hashed and
 * validated before comparison). Throws on any mismatch.
 */
export function validateBaselineLock(
  concerns: Concern[],
  operatingPointsHash: string,
): BaselineLock {
  const lock = loadBaselineLock();
  if (lock.operatingPointsHash !== operatingPointsHash) {
    throw new Error(
      `operating-points hash mismatch: lock ${lock.operatingPointsHash} != current ${operatingPointsHash}`,
    );
  }
  for (const concern of concerns) {
    const actual = artifactHash(concern);
    if (lock.artifactHashes[concern] !== actual) {
      throw new Error(`frozen baseline artifact tampered for ${concern}: ${actual}`);
    }
  }
  return lock;
}

/**
 * Run the full gate: validate the lock, then evaluate every concern's sliced metrics. `pass` is
 * true only if EVERY gated metric passes.
 */
export async function runGate(opts: {
  concerns: Concern[];
  baselineScorer: (c: Concern) => EvalScorer;
  candidateScorer: (c: Concern) => EvalScorer;
  thresholds: Record<Concern, number>;
  operatingPointsHash: string;
  tolerances: Tolerances;
  seed?: number;
  resamples?: number;
}): Promise<GateResult> {
  const lock = validateBaselineLock(opts.concerns, opts.operatingPointsHash);
  const baselineHash = sha256Hex(lock.artifactHashes);
  const verdicts: MetricVerdict[] = [];
  for (const concern of opts.concerns) {
    verdicts.push(
      ...(await gateConcern(
        concern,
        opts.baselineScorer(concern),
        opts.candidateScorer(concern),
        opts.thresholds[concern],
        opts.tolerances,
        opts.seed ?? 999,
        opts.resamples,
      )),
    );
  }
  return {
    pass: verdicts.every((v) => v.pass),
    operatingPointsHash: opts.operatingPointsHash,
    baselineHash,
    verdicts,
  };
}

/** Render a readable per-concern / per-suite diff table. */
export function renderGateDiff(result: GateResult): string {
  const rows = result.verdicts.map((v) => {
    const label = v.suite ? `${v.metric}:${v.suite}` : v.metric;
    const mark = v.pass ? "ok " : "FAIL";
    const fmt = (x: number) => (x * 100).toFixed(1) + "%";
    return (
      `  ${mark} ${v.concern} ${label.padEnd(28)} ` +
      `base ${fmt(v.baseline).padStart(7)} cand ${fmt(v.candidate).padStart(7)} ` +
      `Δ ${fmt(v.delta).padStart(7)} CI [${fmt(v.deltaCI.lower)}, ${fmt(v.deltaCI.upper)}] ` +
      `tol ${(v.tolerance * 100).toFixed(1)}% (${v.direction})`
    );
  });
  const header = `eval gate: ${result.pass ? "PASS" : "FAIL"} · baseline ${result.baselineHash.slice(0, 12)} · operating-points ${result.operatingPointsHash.slice(0, 12)}`;
  return [header, ...rows].join("\n");
}
