import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  evaluateConcern,
  logisticScorer,
  constantScorer,
  seededRandomScorer,
  loadOperatingPoints,
  renderMarkdown,
  type ConcernReport,
} from "@pharos/judge-eval";
import { type JudgeModelArtifact } from "../packages/judge/src/index.js";

const MODELS_DIR = fileURLToPath(new URL("../packages/judge/models", import.meta.url));
function artifact(concern: string): JudgeModelArtifact {
  return JSON.parse(readFileSync(join(MODELS_DIR, `${concern}.model.json`), "utf8"));
}

describe("evaluateConcern (real logistic judge, frozen threshold)", () => {
  it("produces a complete honest report with CIs, controls, and a base-rate box", async () => {
    const op = loadOperatingPoints();
    const report = await evaluateConcern(
      "finra-promissory",
      logisticScorer(artifact("finra-promissory")),
      op.points.thresholds["finra-promissory"],
      op.hash,
      {
        controls: [constantScorer("always-positive", 1), seededRandomScorer("seeded-random", 42)],
      },
    );

    // Uses the frozen threshold + operating-points hash.
    expect(report.threshold).toBe(0.5);
    expect(report.operatingPointsHash).toBe(op.hash);

    // Clean metrics present with bracketing CIs.
    expect(report.clean.positives).toBeGreaterThanOrEqual(300);
    expect(report.clean.prAucCI.lower).toBeLessThanOrEqual(report.clean.prAuc);
    expect(report.clean.prAucCI.upper).toBeGreaterThanOrEqual(report.clean.prAuc);
    expect(report.clean.recallCI.lower).toBeLessThanOrEqual(report.clean.recall);

    // Hard-negative FPR reported.
    expect(report.hardNegatives.count).toBeGreaterThan(0);
    expect(report.hardNegatives.falsePositiveRate).toBeGreaterThanOrEqual(0);

    // Every adversarial suite sliced with a degradation number.
    const suites = new Set(report.adversarial.map((a) => a.suite));
    for (const s of ["paraphrase", "base64", "rot13", "spanish", "german"]) {
      expect(suites.has(s), `missing suite ${s}`).toBe(true);
    }
    // The logistic judge is defeated by base64/rot13 — recall floors at 0 (the ugly baseline).
    const b64 = report.adversarial.find((a) => a.suite === "base64")!;
    expect(b64.recall).toBe(0);

    // Base-rate box: unknown production prevalence → scenarios present.
    expect(report.baseRate.evalPrevalence).toBeCloseTo(0.5, 6);
    expect(report.baseRate.scenarios.map((s) => s.prevalence)).toEqual([0.001, 0.01, 0.05, 0.1]);
    // At 0.1% prevalence, adjusted precision is far below the balanced-eval precision.
    expect(report.baseRate.scenarios[0]!.adjustedPrecision).toBeLessThan(report.clean.precision);

    // Controls present as floors.
    expect(report.controls.map((c) => c.name)).toContain("seeded-random");
  });

  it("is deterministic across runs (seeded bootstrap + deterministic scoring)", async () => {
    const op = loadOperatingPoints();
    const run = (): Promise<ConcernReport> =>
      evaluateConcern(
        "phi-in-context",
        logisticScorer(artifact("phi-in-context")),
        op.points.thresholds["phi-in-context"],
        op.hash,
        { controls: [] },
      );
    const a = await run();
    const b = await run();
    expect(a.clean).toEqual(b.clean);
    expect(a.adversarial).toEqual(b.adversarial);
  });

  it("renders markdown with the base-rate box and PR-AUC lead", async () => {
    const op = loadOperatingPoints();
    const report = await evaluateConcern(
      "funds-movement-intent",
      logisticScorer(artifact("funds-movement-intent")),
      0.5,
      op.hash,
      { controls: [] },
    );
    const md = renderMarkdown([report], {
      generatedNote: "test",
      operatingPointsHash: op.hash,
      datasetHashes: { "funds-movement-intent": "abc" },
      humanReviewStatus: "pending-qualified-review",
      generatorIdentity: "test",
      sharedFamilyLimitation: "test",
    });
    expect(md).toContain("Base-rate box");
    expect(md).toContain("PR-AUC (lead)");
    expect(md).toContain("Adjusted precision");
    expect(md).toContain("Negative controls");
  });
});
