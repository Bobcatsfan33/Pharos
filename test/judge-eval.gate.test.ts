import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONCERNS,
  logisticScorer,
  loadOperatingPoints,
  loadTolerances,
  runGate,
  gateConcern,
  renderGateDiff,
  validateBaselineLock,
  baselineModelsDir,
  type GateResult,
} from "@pharos/judge-eval";
import { type JudgeModelArtifact } from "../packages/judge/src/index.js";

function frozen(concern: string): JudgeModelArtifact {
  return JSON.parse(readFileSync(join(baselineModelsDir(), `${concern}.model.json`), "utf8"));
}

// The ACTUAL served artifacts a PR could change — this is what makes the gate live in CI.
const SERVED_DIR = fileURLToPath(new URL("../packages/judge/models", import.meta.url));
function served(concern: string): JudgeModelArtifact {
  return JSON.parse(readFileSync(join(SERVED_DIR, `${concern}.model.json`), "utf8"));
}

const op = loadOperatingPoints();
const tol = loadTolerances();
// Small resample count keeps the test fast; the CLI uses the default 1000.
const RS = 200;

describe("CI eval gate (S5-T4)", () => {
  it("passes on the live served artifacts vs the frozen baseline (the real CI gate)", async () => {
    // Candidate = the ACTUAL packages/judge/models. A PR that weakens a served judge makes this
    // fail in CI (the `test` job runs on every PR). Today served == frozen, so Δ=0.
    const result: GateResult = await runGate({
      concerns: [...CONCERNS],
      baselineScorer: (c) => logisticScorer(frozen(c)),
      candidateScorer: (c) => logisticScorer(served(c)),
      thresholds: op.points.thresholds,
      operatingPointsHash: op.hash,
      tolerances: tol,
      resamples: RS,
    });
    expect(result.pass).toBe(true);
    expect(result.verdicts.every((v) => v.pass)).toBe(true);
    expect(result.verdicts.every((v) => v.delta === 0)).toBe(true);
    // Every gated slice is present: clean recall/precision/pr-auc/ece, hard-neg FPR, 9 suites.
    const finra = result.verdicts.filter((v) => v.concern === "finra-promissory");
    expect(finra.map((v) => v.metric)).toContain("hard-negative-fpr");
    expect(finra.filter((v) => v.metric === "adversarial-recall")).toHaveLength(9);
  });

  it("is deterministic across runs (seeded paired bootstrap)", async () => {
    const run = () =>
      gateConcern(
        "finra-promissory",
        logisticScorer(frozen("finra-promissory")),
        logisticScorer(frozen("finra-promissory")),
        0.5,
        tol,
        999,
        RS,
      );
    expect(await run()).toEqual(await run());
  });

  it("FAILS a deliberately-nerfed candidate with a readable per-slice diff", async () => {
    // Nerf: strip the learned weights and push the bias very negative → probability ≈ 0 →
    // recall collapses on the clean + adversarial positives (a large, real regression).
    const base = frozen("finra-promissory");
    const nerfed: JudgeModelArtifact = { ...base, weights: {}, bias: -12 };

    const verdicts = await gateConcern(
      "finra-promissory",
      logisticScorer(base),
      logisticScorer(nerfed),
      0.5,
      tol,
      999,
      RS,
    );
    const result: GateResult = {
      pass: verdicts.every((v) => v.pass),
      operatingPointsHash: op.hash,
      baselineHash: "nerf-test",
      verdicts,
    };

    expect(result.pass).toBe(false);
    const recallV = verdicts.find((v) => v.metric === "clean-recall")!;
    expect(recallV.pass).toBe(false);
    expect(recallV.candidate).toBeLessThan(recallV.baseline);
    expect(recallV.deltaCI.upper).toBeLessThan(recallV.tolerance); // entire interval worse

    // The readable diff names the failing slice with base/cand/delta/CI/tolerance.
    const diff = renderGateDiff(result);
    expect(diff).toContain("FAIL");
    expect(diff).toContain("clean-recall");
    expect(diff).toMatch(/CI \[/);
  });

  it("validates the baseline lock before comparing (throws on a tampered operating-points hash)", () => {
    expect(() => validateBaselineLock([...CONCERNS], op.hash)).not.toThrow();
    expect(() => validateBaselineLock([...CONCERNS], "deadbeef")).toThrow(
      /operating-points hash mismatch/,
    );
  });
});
