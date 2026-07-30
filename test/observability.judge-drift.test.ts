import { describe, expect, it } from "vitest";
import {
  JudgeDriftMonitor,
  MetricsRegistry,
  populationStabilityIndex,
  validateJudgeDriftProfile,
  type JudgeDriftProfile,
} from "@pharos/observability";

const profile: JudgeDriftProfile = {
  schemaVersion: "1.0.0",
  binUpperBounds: [0.25, 0.5, 0.75, 1],
  windowSize: 4,
  minSamples: 4,
  warningPsi: 0.1,
  criticalPsi: 0.25,
  models: {
    "phi@approved": {
      concern: "phi-in-context",
      referenceDistribution: [0.25, 0.25, 0.25, 0.25],
    },
  },
};

describe("judge drift monitoring", () => {
  it("warms up, calculates PSI, and retains a bounded rolling window", () => {
    const metrics = new MetricsRegistry();
    const monitor = new JudgeDriftMonitor(metrics, profile);

    for (const probability of [0.1, 0.3, 0.6]) {
      const snapshot = monitor.observe({
        concern: "phi-in-context",
        judgeVersion: "phi@approved",
        probability,
        flagged: false,
      });
      expect(snapshot?.status).toBe("warming");
      expect(snapshot?.psi).toBeNull();
    }
    const normal = monitor.observe({
      concern: "phi-in-context",
      judgeVersion: "phi@approved",
      probability: 0.9,
      flagged: true,
    });
    expect(normal).toMatchObject({ sampleCount: 4, windowSize: 4, status: "normal", psi: 0 });

    const shifted = monitor.observe({
      concern: "phi-in-context",
      judgeVersion: "phi@approved",
      probability: 0.9,
      flagged: true,
    });
    expect(shifted?.sampleCount).toBe(4);
    expect(shifted?.psi).toBeGreaterThan(profile.criticalPsi);
    expect(shifted?.status).toBe("critical");

    const text = metrics.render();
    expect(text).toContain(
      'pharos_judge_drift_status{concern="phi-in-context",model_version="phi@approved",status="critical"} 1',
    );
    expect(text).toContain(
      'pharos_judge_drift_window_samples{concern="phi-in-context",model_version="phi@approved"} 4',
    );
    expect(text).not.toContain("tenant");
  });

  it("surfaces an unprofiled version without inventing a drift decision", () => {
    const metrics = new MetricsRegistry();
    const monitor = new JudgeDriftMonitor(metrics, profile);
    const result = monitor.observe({
      concern: "phi-in-context",
      judgeVersion: "phi@unapproved",
      probability: 0.9,
      flagged: true,
    });

    expect(result).toBeNull();
    expect(
      metrics.judgeDriftProfileReady.get({
        concern: "phi-in-context",
        model_version: "phi@unapproved",
      }),
    ).toBe(0);
    expect(
      metrics.judgeDriftProfileMissing.get({
        concern: "phi-in-context",
        model_version: "phi@unapproved",
      }),
    ).toBe(1);
  });

  it("rejects missing, mismatched, and malformed production profiles", () => {
    const monitor = new JudgeDriftMonitor(new MetricsRegistry(), profile);
    expect(() =>
      monitor.assertModelsConfigured([{ concern: "phi-in-context", judgeVersion: "phi@missing" }]),
    ).toThrow("missing active model");
    expect(() =>
      monitor.assertModelsConfigured([{ concern: "wrong-concern", judgeVersion: "phi@approved" }]),
    ).toThrow("expected wrong-concern");

    expect(() =>
      validateJudgeDriftProfile({
        ...profile,
        models: {
          "phi@approved": {
            concern: "phi-in-context",
            referenceDistribution: [0.1, 0.2, 0.3, 0.3],
          },
        },
      }),
    ).toThrow("must sum to 1");
    expect(() => validateJudgeDriftProfile({ ...profile, approved: true })).toThrow(
      "unknown field approved",
    );
  });

  it("calculates zero only for identical distributions", () => {
    expect(populationStabilityIndex([0.2, 0.8], [0.2, 0.8])).toBe(0);
    expect(populationStabilityIndex([0.8, 0.2], [0.2, 0.8])).toBeGreaterThan(1);
  });
});
