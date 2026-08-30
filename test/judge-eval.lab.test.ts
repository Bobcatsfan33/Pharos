import { describe, expect, it } from "vitest";
import { AssuranceLab, registerDataset, type GateResult } from "@pharos/judge-eval";

const dataset = registerDataset({
  id: "transfers",
  version: "1.0.0",
  slices: ["clean", "adversarial"],
  recordCount: 500,
  provenance: {
    source: "synthetic-fixtures",
    collectedAt: "2026-01-01T00:00:00.000Z",
    license: "CC0-1.0",
    containsPersonalData: false,
  },
});

const gate = (pass: boolean): GateResult => ({
  pass,
  operatingPointsHash: "op",
  baselineHash: "base",
  verdicts: [],
});

describe("assurance lab", () => {
  it("promotes only candidates with green gates, drift, and approval checks", () => {
    const lab = new AssuranceLab("model-v1");
    const result = lab.evaluate({
      candidateId: "model-v2",
      gate: gate(true),
      dataset,
      driftSignals: [{ name: "psi", value: 0.05, threshold: 0.2, direction: "maximum" }],
      requiredApprovals: 2,
      approvalSubjects: ["alice", "bob"],
      evaluatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.status).toBe("promote");
    expect(lab.champion()).toBe("model-v2");
  });

  it("orders an automatic rollback for a deployed challenger that regresses", () => {
    const lab = new AssuranceLab("model-v1");
    const result = lab.evaluate({
      candidateId: "model-v2",
      gate: gate(false),
      dataset,
      deployedCandidate: true,
    });
    expect(result.status).toBe("rollback");
    expect(result.reasons).toContain("statistical evaluation gate failed");
  });

  it("refuses personal-data datasets without a processing basis", () => {
    expect(() =>
      registerDataset({
        id: "bad",
        version: "1",
        slices: ["all"],
        recordCount: 1,
        provenance: {
          source: "production",
          collectedAt: "2026-01-01T00:00:00.000Z",
          license: "internal",
          containsPersonalData: true,
        },
      }),
    ).toThrow(/consent/);
  });
});
