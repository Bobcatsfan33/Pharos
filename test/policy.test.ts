import { describe, it, expect } from "vitest";
import {
  compilePolicy,
  evaluateArtifact,
  decideWith,
  dryRun,
  divergence,
  FINRA_PACK_V2,
  HIPAA_PACK_V2,
  type EvalContext,
  type PolicyArtifact,
} from "@pharos/policy";

function ctx(over: Partial<{ type: string; amount: number; mandate: unknown; judges: Record<string, number> }> = {}): EvalContext {
  return {
    request: {
      tenantId: "t",
      action: { type: over.type ?? "payment.transfer", agentId: "a", payload: {}, emittedAt: "2026-06-01T00:00:00.000Z" },
      liability: { mandate: (over.mandate as never) ?? null, oversightMode: "autonomous", blastRadius: { financialAmount: over.amount ?? 0, currency: "USD", reversibility: "reversible" }, modelMetadata: null },
    },
    judgeProbabilities: over.judges ?? {},
  };
}

describe("shipped regulation packs (citation-level)", () => {
  it("every rule carries a citation/clause and an examiner-readable description", () => {
    for (const pack of [FINRA_PACK_V2, HIPAA_PACK_V2]) {
      for (const rule of pack.rules) {
        expect(rule.clause).toBeTruthy();
        expect(rule.description.length).toBeGreaterThan(20);
      }
    }
  });

  it("FINRA blocks promissory language (judge-driven)", () => {
    const matches = evaluateArtifact(FINRA_PACK_V2, ctx({ type: "email.send", judges: { "finra-promissory": 0.9 } }));
    expect(matches.some((m) => m.citation.ruleId === "finra-2210-promissory" && m.decision === "block")).toBe(true);
  });

  it("FINRA escalates large transfers (field-driven)", () => {
    const d = decideWith(FINRA_PACK_V2, ctx({ type: "payment.transfer", amount: 75000 }));
    expect(d).toBe("escalate");
  });

  it("HIPAA escalates PHI in context", () => {
    const d = decideWith(HIPAA_PACK_V2, ctx({ type: "message.send", judges: { "phi-in-context": 0.7 } }));
    expect(d).toBe("escalate");
  });
});

describe("policy compiler", () => {
  it("compiles natural-language statements into citation-bearing rules", () => {
    const text = [
      "# Acme payments policy",
      "Block payments when amount over $50000",
      "Require human approval for wires",
      "Block promissory language",
      "this line is not a recognized rule",
    ].join("\n");
    const result = compilePolicy("acme", "1", "Acme", text);
    expect(result.rules.length).toBe(3);
    expect(result.unparsed.length).toBe(1);
    const artifact: PolicyArtifact = { packId: "acme", version: "1", title: "Acme", rules: result.rules };
    // The compiled "block payments over 50k" fires on a 60k payment.
    expect(decideWith(artifact, ctx({ type: "payment.transfer", amount: 60000 }))).toBe("block");
    // ...and not on a 10k payment.
    expect(decideWith(artifact, ctx({ type: "payment.transfer", amount: 10000 }))).toBe("allow");
  });

  it("flags low-confidence / unrecognized lines for human review", () => {
    const result = compilePolicy("acme", "1", "Acme", "Block emails when subject mentions \"merger\"\ngibberish line");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("dry-run impact + divergence", () => {
  const artifact: PolicyArtifact = {
    packId: "acme", version: "1", title: "Acme",
    rules: [{ ruleId: "acme-r1", pack: "acme", description: "Block payments over 25k for the impact demo.", when: { all: [{ field: "action.type", op: "startsWith", value: "payment." }, { field: "liability.blastRadius.financialAmount", op: "gt", value: 25000 }] }, decision: "block" }],
  };
  const contexts = [
    ctx({ type: "payment.transfer", amount: 30000 }),
    ctx({ type: "payment.transfer", amount: 5000 }),
    ctx({ type: "email.send", amount: 0 }),
    ctx({ type: "payment.transfer", amount: 40000 }),
  ];

  it("predicts the verdict mix over a window", () => {
    const result = dryRun(artifact, contexts);
    expect(result.total).toBe(4);
    expect(result.mix.block).toBe(2); // the two >25k payments
    expect(result.mix.allow).toBe(2);
    expect(result.byRule["acme-r1"]).toBe(2);
  });

  it("reports divergence against an empty active policy", () => {
    const empty: PolicyArtifact = { packId: "none", version: "1", title: "none", rules: [] };
    const d = divergence(empty, artifact, contexts);
    expect(d.diverged).toBe(2); // 2 allow->block changes
    expect(d.changes.some((c) => c.from === "allow" && c.to === "block" && c.count === 2)).toBe(true);
  });
});
