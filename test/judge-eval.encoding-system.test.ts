import { describe, it, expect } from "vitest";
import {
  ENCODING_SUITE,
  ENCODINGS,
  encode,
  detectLeakage,
  loadConcern,
  CONCERNS,
} from "@pharos/judge-eval";
import { normalizedVariants, canonicalize } from "@pharos/cascade";
import { FINRA_PROMISSORY } from "../packages/judge/data/finra-promissory.js";
import { PHI_IN_CONTEXT } from "../packages/judge/data/phi-in-context.js";
import { FUNDS_MOVEMENT_INTENT } from "../packages/judge/data/funds-movement-intent.js";

/**
 * Hermetic guarantees for the ENCODING system eval (WS5). The model-alone-vs-system RECALL numbers
 * (which need the served ONNX judge) live in the live report; here we prove the two things CI must
 * enforce: (1) the encoding-suite plaintext does not leak train/eval (Amendment 10(d)), and (2) the
 * cascade normalizer actually RECOVERS each encoded positive's plaintext — the mechanism the system
 * win rests on.
 */
describe("encoding suite ↔ leakage gate (Amendment 10(d))", () => {
  it("has zero n-gram overlap with any training OR eval split (and fires on a seeded dup)", () => {
    const trainEval: string[] = [
      ...FINRA_PROMISSORY.map((e) => e.text),
      ...PHI_IN_CONTEXT.map((e) => e.text),
      ...FUNDS_MOVEMENT_INTENT.map((e) => e.text),
      ...CONCERNS.flatMap((c) =>
        loadConcern(c).splits.flatMap((s) => s.examples.map((e) => e.text)),
      ),
    ];
    const records = ENCODING_SUITE.map((e, i) => ({ id: `enc/${i}`, text: e.text }));
    const report = detectLeakage(records, trainEval);
    expect(report.exactMatches).toBe(0);
    expect(report.hits).toHaveLength(0);

    // The gate must FIRE on a seeded near-duplicate of an eval example.
    const anEval = loadConcern("finra-promissory").splits.find((s) => s.suite === "clean-positive")!
      .examples[0]!.text;
    const fired = detectLeakage([{ id: "seed", text: anEval }], trainEval);
    expect(fired.hits.length).toBeGreaterThan(0);
  });
});

describe("normalizer recovers encoded plaintext (the system mechanism)", () => {
  for (const encoding of ENCODINGS) {
    it(`recovers the canonical plaintext of every positive under ${encoding}`, () => {
      for (const ex of ENCODING_SUITE.filter((e) => e.label === 1)) {
        const target = canonicalize(ex.text);
        const variants = normalizedVariants(encode(ex.text, encoding));
        // Some normalized variant must CONTAIN the canonical plaintext (base64/homoglyph recover it
        // exactly; ROT13 leaves the short carrier as gibberish, so the payload is a substring), so
        // the judge sees the real promissory content.
        expect(
          variants.some((v) => v.includes(target)),
          `${encoding}: ${ex.text}`,
        ).toBe(true);
      }
    });
  }
});
