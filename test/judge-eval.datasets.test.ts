import { describe, it, expect } from "vitest";
import {
  CONCERNS,
  ADVERSARIAL_SUITES,
  loadConcern,
  loadAllConcerns,
  splitContentHash,
  type EvalSplit,
} from "@pharos/judge-eval";

/**
 * Validity of the committed eval datasets (roadmap S5-T1 + §7-10(a)). These assert the dataset
 * SHAPE and VALIDITY contract that the harness and the honesty of the baseline depend on. The
 * separate leakage gate lives in judge-eval.leakage.test.ts.
 */
describe("judge-eval committed datasets", () => {
  it("loads all three concerns and verifies every split's content hash", () => {
    // loadConcern throws on hash mismatch, so a clean load IS the hash verification.
    const loaded = loadAllConcerns();
    expect(loaded).toHaveLength(3);
    for (const { manifest, splits } of loaded) {
      for (const s of splits) {
        const entry = manifest.splits.find((e) => e.suite === s.suite && e.lang === s.lang)!;
        expect(splitContentHash(s)).toBe(entry.contentHash);
      }
    }
  });

  for (const concern of CONCERNS) {
    describe(concern, () => {
      const { manifest, splits } = loadConcern(concern);
      const bySuite = (suite: string): EvalSplit => splits.find((s) => s.suite === suite)!;

      it("has ≥300 clean positives and ≥300 clean negatives", () => {
        expect(bySuite("clean-positive").count).toBeGreaterThanOrEqual(300);
        expect(bySuite("clean-positive").examples.every((e) => e.label === 1)).toBe(true);
        expect(bySuite("clean-negative").count).toBeGreaterThanOrEqual(300);
        expect(bySuite("clean-negative").examples.every((e) => e.label === 0)).toBe(true);
      });

      it("negative split is ≥60% hard negatives (§7-10(a))", () => {
        const neg = bySuite("clean-negative");
        const frac = neg.hardNegatives / neg.count;
        expect(frac).toBeGreaterThanOrEqual(manifest.taxonomy.minHardNegativeFraction);
        expect(frac).toBeGreaterThanOrEqual(0.6);
      });

      it("covers every near-miss taxonomy class among the hard negatives", () => {
        const neg = bySuite("clean-negative");
        const present = new Set(
          neg.examples.filter((e) => e.hardNegative).map((e) => e.nearMissClass),
        );
        for (const cls of manifest.taxonomy.classes) {
          expect(present.has(cls.id), `missing near-miss class ${cls.id}`).toBe(true);
        }
      });

      it("has all seven adversarial suites (obfuscated positives)", () => {
        for (const suite of ADVERSARIAL_SUITES) {
          if (suite === "spanish" || suite === "german") continue;
          const s = bySuite(suite);
          expect(s.count).toBeGreaterThan(0);
          expect(s.examples.every((e) => e.label === 1)).toBe(true);
        }
      });

      it("has native spanish and german suites in the right language", () => {
        expect(bySuite("spanish").lang).toBe("es");
        expect(bySuite("german").lang).toBe("de");
        expect(bySuite("spanish").examples.some((e) => e.label === 1)).toBe(true);
        expect(bySuite("spanish").examples.some((e) => e.label === 0)).toBe(true);
      });

      it("has globally unique example ids", () => {
        const ids = splits.flatMap((s) => s.examples.map((e) => e.id));
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("every label is grounded in a cited source and human review is tracked", () => {
        for (const s of splits) {
          for (const e of s.examples) {
            expect(manifest.sources[e.source], `unknown source ${e.source}`).toBeTruthy();
          }
        }
        expect(manifest.humanReview.status).toBeDefined();
        expect(manifest.datasetHash).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  }
});
