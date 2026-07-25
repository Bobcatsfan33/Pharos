import { describe, it, expect } from "vitest";
import { CONCERNS, loadConcern, detectLeakage, type Concern } from "@pharos/judge-eval";
import { FINRA_PROMISSORY } from "../packages/judge/data/finra-promissory.js";
import { PHI_IN_CONTEXT } from "../packages/judge/data/phi-in-context.js";
import { FUNDS_MOVEMENT_INTENT } from "../packages/judge/data/funds-movement-intent.js";

/**
 * The leakage gate (roadmap S5-T1 + §7-10(d)): the committed eval data must not overlap the
 * training data by normalized-exact match OR feature-aligned n-gram similarity, AND the gate must
 * be proven to FIRE on a seeded near-duplicate (otherwise "0 hits" is meaningless).
 */
const TRAIN: Record<Concern, { text: string }[]> = {
  "finra-promissory": FINRA_PROMISSORY,
  "phi-in-context": PHI_IN_CONTEXT,
  "funds-movement-intent": FUNDS_MOVEMENT_INTENT,
};

describe("judge-eval ↔ training leakage gate", () => {
  for (const concern of CONCERNS) {
    it(`${concern}: committed eval data has zero exact + zero n-gram overlap with training`, () => {
      const { splits } = loadConcern(concern);
      const records = splits.flatMap((s) => s.examples).map((e) => ({ id: e.id, text: e.text }));
      const report = detectLeakage(
        records,
        TRAIN[concern].map((t) => t.text),
      );
      if (report.hits.length > 0) {
        // Surface the offenders for a readable failure.
        console.error(
          report.hits
            .slice(0, 5)
            .map((h) => `${h.reason} ${h.bigramContainment.toFixed(2)} :: ${h.evalText}`),
        );
      }
      expect(report.exactMatches).toBe(0);
      expect(report.hits).toHaveLength(0);
    });
  }

  it("FIRES on a seeded exact duplicate of a training example", () => {
    const train = FINRA_PROMISSORY.map((t) => t.text);
    const seeded = [{ id: "seed/exact", text: train[0]! }];
    const report = detectLeakage(seeded, train);
    expect(report.exactMatches).toBe(1);
    expect(report.hits[0]!.reason).toBe("exact");
  });

  it("FIRES on a seeded near-duplicate (high bigram containment / trigram Jaccard)", () => {
    // A one-token variation of a real training positive: nearly all bigrams still match.
    const original = "We guarantee a 20% return on your investment every year with no risk.";
    // Only the percentage changes: nearly every bigram still overlaps → a leakage near-dup.
    const nearDup = "We guarantee a 35% return on your investment every year with no risk.";
    const report = detectLeakage([{ id: "seed/near", text: nearDup }], [original]);
    expect(report.hits).toHaveLength(1);
    expect(["bigram-containment", "trigram-jaccard"]).toContain(report.hits[0]!.reason);
    expect(report.hits[0]!.bigramContainment).toBeGreaterThanOrEqual(0.8);
  });

  it("does NOT fire on genuinely different text about the same concept", () => {
    const original = "We guarantee a 20% return on your investment every year with no risk.";
    const different =
      "Your money only grows with our flagship strategy: a bulletproof yield you can bank on.";
    const report = detectLeakage([{ id: "seed/diff", text: different }], [original]);
    expect(report.hits).toHaveLength(0);
  });
});
