import { describe, it, expect } from "vitest";
import {
  routeEscalation,
  slaState,
  draftRuleCandidates,
  isDisagreement,
  summarize,
  type ResolvedItem,
  type ReviewRecord,
} from "@pharos/review";

describe("queue routing", () => {
  it("routes HIPAA items to the privacy office", () => {
    const r = routeEscalation({ actionType: "message.send", riskScore: 0.4, packs: ["hipaa"], financialAmount: 0, reversibility: "reversible" });
    expect(r.queue).toBe("privacy-office");
  });
  it("routes FINRA items to the registered principal", () => {
    const r = routeEscalation({ actionType: "email.send", riskScore: 0.4, packs: ["finra"], financialAmount: 0, reversibility: "reversible" });
    expect(r.queue).toBe("registered-principal");
  });
  it("routes payments to treasury control with high priority + tight SLA", () => {
    const r = routeEscalation({ actionType: "payment.transfer", riskScore: 0.95, packs: [], financialAmount: 200000, reversibility: "irreversible" });
    expect(r.queue).toBe("treasury-control");
    expect(r.priority).toBe(1);
    expect(r.slaMinutes).toBe(15);
    expect(r.fourEyes).toBe(true);
  });
  it("defaults low-risk items to the general queue with a relaxed SLA", () => {
    const r = routeEscalation({ actionType: "crm.update", riskScore: 0.1, packs: [], financialAmount: 0, reversibility: "reversible" });
    expect(r.queue).toBe("general");
    expect(r.priority).toBe(4);
    expect(r.slaMinutes).toBe(1440);
  });
});

describe("SLA state", () => {
  const created = 0;
  const due = 100;
  it("ok early in the window", () => expect(slaState(created, due, 50)).toBe("ok"));
  it("at_risk in the last 20%", () => expect(slaState(created, due, 85)).toBe("at_risk"));
  it("breached past due", () => expect(slaState(created, due, 100)).toBe("breached"));
});

describe("disagreement + rule candidates", () => {
  it("flags disagreement when human overturns the machine's risk lean", () => {
    // Machine leaned stop (risk 0.8) but human approved -> disagreement.
    expect(isDisagreement({ escalationId: "1", riskScore: 0.8, citedRules: ["r"], dominantPack: "finra", humanDecision: "approve" })).toBe(true);
    // Machine leaned go (risk 0.2) and human approved -> agreement.
    expect(isDisagreement({ escalationId: "2", riskScore: 0.2, citedRules: ["r"], dominantPack: null, humanDecision: "approve" })).toBe(false);
  });

  it("clusters disagreements into draft rule candidates", () => {
    const items: ResolvedItem[] = Array.from({ length: 5 }, (_, i) => ({
      escalationId: `e${i}`,
      riskScore: 0.8,
      citedRules: ["finra-2210-promissory"],
      dominantPack: "finra",
      humanDecision: "approve" as const, // humans keep approving a flagged rule -> loosen
    }));
    const candidates = draftRuleCandidates(items, 3);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.ruleId).toBe("finra-2210-promissory");
    expect(candidates[0]!.direction).toBe("loosen");
    expect(candidates[0]!.disagreements).toBe(5);
  });
});

describe("analytics summary", () => {
  it("computes review time, SLA attainment, and disagreement rate", () => {
    const records: ReviewRecord[] = [
      { escalationId: "1", queue: "general", riskScore: 0.8, citedRules: ["r"], dominantPack: null, humanDecision: "approve", createdAtMs: 0, resolvedAtMs: 100, slaDueAtMs: 200, resolvedBy: "alice" },
      { escalationId: "2", queue: "general", riskScore: 0.1, citedRules: ["r"], dominantPack: null, humanDecision: "approve", createdAtMs: 0, resolvedAtMs: 300, slaDueAtMs: 200, resolvedBy: "bob" },
    ];
    const s = summarize(records);
    expect(s.resolved).toBe(2);
    expect(s.medianReviewTimeMs).toBe(200); // median of [100,300]
    expect(s.slaAttainment).toBe(0.5); // one on time, one late
    expect(s.disagreementRate).toBe(0.5); // item 1 disagrees, item 2 agrees
    expect(s.byReviewer).toEqual({ alice: 1, bob: 1 });
  });
});
