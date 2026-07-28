import { describe, it, expect } from "vitest";
import {
  canonicalize,
  decodeCandidates,
  normalizedVariants,
  NORMALIZER_VERSION,
} from "@pharos/cascade";

/**
 * Cascade-owned normalizer (ADR 0004): unit behavior + a fuzz suite. The normalizer runs on the
 * verdict path on hostile input, so it must be idempotent, bounded, and never throw/stall.
 */
describe("normalizer — unicode canonicalization", () => {
  it("folds confusable homoglyphs to ASCII", () => {
    // "guаrantee" with a Cyrillic 'а' (U+0430) → ASCII 'a'.
    expect(canonicalize("We guаrantee")).toBe("we guarantee");
  });

  it("strips zero-width / soft-hyphen / BOM splitters", () => {
    expect(canonicalize("gu​arant­ee")).toBe("guarantee");
  });

  it("applies NFKC, casefold, and whitespace collapse", () => {
    expect(canonicalize("ＧＵＡＲＡＮＴＥＥ")).toBe("guarantee"); // fullwidth → ascii via NFKC
    expect(canonicalize("  HÉLLO   Wörld  ")).toBe("héllo wörld");
  });

  it("is idempotent", () => {
    for (const s of ["HÉLLO  Wörld", "gu​aranteе", "  A  B  "]) {
      expect(canonicalize(canonicalize(s))).toBe(canonicalize(s));
    }
  });
});

describe("normalizer — reversible-encoding decode", () => {
  it("decodes a base64 payload run to plaintext", () => {
    const b64 = Buffer.from("We guarantee a fixed return with no risk").toString("base64");
    const variants = normalizedVariants(`Please see the note below: ${b64}`);
    expect(variants).toContain("we guarantee a fixed return with no risk");
  });

  it("decodes ROT13 to plaintext", () => {
    const rot = "Jr thnenagrr n svkrq erghea"; // ROT13 of "We guarantee a fixed return"
    expect(decodeCandidates(rot)).toContain("We guarantee a fixed return");
  });

  it("is bounded: a decode-bomb does not explode output", () => {
    const bomb = "A".repeat(50_000); // decodes to ~37KB of NUL-ish bytes; must stay bounded
    const variants = normalizedVariants(`x ${bomb}`);
    expect(variants.length).toBeLessThanOrEqual(8);
    for (const v of variants) expect(v.length).toBeLessThanOrEqual(100_000);
  });

  it("has a content-hashed version id", () => {
    expect(NORMALIZER_VERSION).toMatch(/^norm@[0-9a-f]{12}$/);
  });
});

// A tiny seeded PRNG so the fuzz corpus is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnicode(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * maxLen);
  let s = "";
  for (let i = 0; i < len; i++) {
    const pick = rng();
    let cp: number;
    if (pick < 0.15)
      cp = Math.floor(rng() * 0x20); // control chars
    else if (pick < 0.25)
      cp = [0x200b, 0x200d, 0xfeff, 0x00ad, 0x2069][Math.floor(rng() * 5)]!; // invisibles
    else if (pick < 0.4)
      cp = 0x10000 + Math.floor(rng() * 0xfffff); // astral plane
    else cp = Math.floor(rng() * 0x1000); // BMP
    try {
      s += String.fromCodePoint(cp);
    } catch {
      s += "?";
    }
  }
  return s;
}

describe("normalizer — fuzz (property tests)", () => {
  it("never throws, is idempotent, and is length-bounded on arbitrary unicode", () => {
    const rng = mulberry32(1234);
    for (let i = 0; i < 500; i++) {
      const s = randomUnicode(rng, 200);
      let canon: string;
      expect(() => {
        canon = canonicalize(s);
        // idempotence
        expect(canonicalize(canon)).toBe(canon);
        // length bound (never expands beyond the input cap)
        expect(canon.length).toBeLessThanOrEqual(100_000);
        // variants never throw and are capped
        const variants = normalizedVariants(s);
        expect(variants.length).toBeLessThanOrEqual(8);
        for (const v of variants) expect(v.length).toBeLessThanOrEqual(100_000);
      }).not.toThrow();
    }
  });

  it("does not stall on a pathological long input", () => {
    const huge = "aГ0​".repeat(60_000); // ~240K chars, mixed script + invisibles
    const t0 = Date.now();
    const variants = normalizedVariants(huge);
    expect(Date.now() - t0).toBeLessThan(2000); // bounded work, no stall
    expect(variants.length).toBeLessThanOrEqual(8);
  });
});
