/**
 * CI eval gate (roadmap S5-T4). Compares the CANDIDATE judge artifacts (packages/judge/models)
 * against the FROZEN baseline (packages/judge-eval/data/baseline-models) at the frozen thresholds,
 * failing only when a sliced metric's entire 95% paired-bootstrap delta interval is worse than its
 * committed tolerance.
 *
 *   pnpm judges:gate
 *
 * Runs automatically in CI via test/judge-eval.gate.test.ts (the `test` job runs on every PR that
 * touches packages/judge, judge artifacts, operating points, or eval code). This CLI is the same
 * gate for local use + a readable diff.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { type JudgeModelArtifact } from "../packages/judge/src/index.js";
import {
  CONCERNS,
  type Concern,
  logisticScorer,
  loadOperatingPoints,
  loadTolerances,
  runGate,
  renderGateDiff,
  baselineModelsDir,
} from "../packages/judge-eval/src/index.js";

const CANDIDATE_DIR = fileURLToPath(new URL("../packages/judge/models", import.meta.url));

function load(dir: string, concern: Concern): JudgeModelArtifact {
  return JSON.parse(readFileSync(join(dir, `${concern}.model.json`), "utf8")) as JudgeModelArtifact;
}

async function main(): Promise<void> {
  const op = loadOperatingPoints();
  const result = await runGate({
    concerns: [...CONCERNS],
    baselineScorer: (c) => logisticScorer(load(baselineModelsDir(), c)),
    candidateScorer: (c) => logisticScorer(load(CANDIDATE_DIR, c)),
    thresholds: op.points.thresholds,
    operatingPointsHash: op.hash,
    tolerances: loadTolerances(),
  });
  console.log(renderGateDiff(result));
  if (!result.pass) {
    console.error("\neval gate FAILED — a sliced metric regressed beyond tolerance.");
    process.exit(1);
  }
  console.log("\neval gate passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
