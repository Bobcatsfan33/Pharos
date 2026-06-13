import { describe, it, expect } from "vitest";
import {
  wilsonInterval,
  wilsonLowerBound,
  computeRiskProfile,
  evaluateReadiness,
  buildUnderwriterFeed,
  UNDERWRITER_FEED_VERSION,
  type RecordSummary,
} from "@pharos/assurance";

describe("Wilson score", () => {
  it("returns 0 for no samples", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
  it("lower bound is below the point estimate and tightens with n", () => {
    const small = wilsonInterval(19, 20); // 95%
    const large = wilsonInterval(950, 1000); // 95%
    expect(small.lower).toBeLessThan(small.point);
    expect(large.lower).toBeLessThan(large.point);
    // Same proportion, larger n -> tighter (higher) lower bound.
    expect(large.lower).toBeGreaterThan(small.lower);
  });
  it("computes a known interval", () => {
    const i = wilsonInterval(960, 1000);
    expect(i.point).toBeCloseTo(0.96, 5);
    expect(i.lower).toBeGreaterThan(0.94);
    expect(i.lower).toBeLessThan(0.96);
    expect(i.confidence).toBe(0.95);
  });
});

function summaries(spec: Array<Partial<RecordSummary>>): RecordSummary[] {
  return spec.map((s) => ({
    decision: s.decision ?? "allow",
    oversightMode: s.oversightMode ?? "autonomous",
    reversibility: s.reversibility ?? "reversible",
    financialAmount: s.financialAmount ?? 0,
    failMode: s.failMode ?? null,
    mandatePresent: s.mandatePresent ?? false,
  }));
}

describe("risk profile v2", () => {
  it("computes posture metrics and a grade", () => {
    const recs = summaries([
      { oversightMode: "autonomous", reversibility: "irreversible", financialAmount: 1000 },
      { oversightMode: "human_in_loop", decision: "escalate", financialAmount: 500, mandatePresent: true },
      { oversightMode: "human_on_loop", decision: "block" },
    ]);
    const p = computeRiskProfile(recs, wilsonInterval(960, 1000), 0.05);
    expect(p.records).toBe(3);
    expect(p.autonomyRate).toBeCloseTo(1 / 3, 5);
    expect(p.irreversibleMix).toBeCloseTo(1 / 3, 5);
    expect(p.oversightCoverage).toBeCloseTo(2 / 3, 5);
    expect(["A", "B", "C", "D"]).toContain(p.grade);
  });
});

describe("readiness gate", () => {
  const recs = summaries([
    { financialAmount: 30000, reversibility: "irreversible", oversightMode: "human_in_loop", mandatePresent: false },
    { financialAmount: 20000, reversibility: "irreversible", oversightMode: "human_in_loop", mandatePresent: false },
  ]);

  it("blocks external release when mandate coverage is below threshold", () => {
    const r = evaluateReadiness(recs, true);
    expect(r.blocked).toBe(true);
    const mc = r.checks.find((c) => c.id === "mandate-coverage")!;
    expect(mc.passed).toBe(false);
  });

  it("unblocks when an owner grants an exception", () => {
    const r = evaluateReadiness(recs, true, undefined, { "mandate-coverage": "risk-owner@acme" });
    expect(r.blocked).toBe(false);
    const mc = r.checks.find((c) => c.id === "mandate-coverage")!;
    expect(mc.excepted).toBe(true);
    expect(mc.owner).toBe("risk-owner@acme");
  });

  it("blocks when the chain is incomplete", () => {
    const r = evaluateReadiness(summaries([{ mandatePresent: true }]), false);
    expect(r.checks.find((c) => c.id === "chain-completeness")!.passed).toBe(false);
  });
});

describe("underwriter feed", () => {
  it("is versioned and carries the measured assurance bound", () => {
    const interval = wilsonInterval(960, 1000);
    const profile = computeRiskProfile(summaries([{ mandatePresent: true }]), interval, 0.02);
    const feed = buildUnderwriterFeed("acme", profile, interval, "2026-07-01T00:00:00.000Z");
    expect(feed.feedVersion).toBe(UNDERWRITER_FEED_VERSION);
    expect(feed.assurance.verifiedAccuracyLowerBound).toBeGreaterThan(0.94);
    expect(feed.assurance.sampleSize).toBe(1000);
    expect(feed.riskGrade).toBeTruthy();
  });
});
