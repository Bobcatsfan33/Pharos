import { describe, it, expect } from "vitest";
import {
  TRANSFORMS,
  tokenize,
  base64WrapHardened,
  rot13WrapHardened,
  generateConcern,
} from "@pharos/judge-eval";

/**
 * Adversarial transforms must be deterministic (so suites are reproducible from the clean
 * positives) and must actually shift the n-gram surface (so they test brittle features).
 */
describe("adversarial transforms", () => {
  const sample = "Please wire 12,500 dollars to vendor Acme now and confirm once sent.";

  it("are pure functions (same input → same output)", () => {
    for (const [name, fn] of Object.entries(TRANSFORMS)) {
      expect(fn(sample), name).toBe(fn(sample));
    }
  });

  it("shift the token surface vs the original (or wrap it in a carrier)", () => {
    const origTokens = [...new Set(tokenize(sample))].sort().join(" ");
    for (const [name, fn] of Object.entries(TRANSFORMS)) {
      const out = fn(sample);
      expect(out, name).not.toBe(sample);
      // The distinct-token SET must differ (leetspeak preserves length but changes tokens).
      const outTokens = [...new Set(tokenize(out))].sort().join(" ");
      expect(outTokens, name).not.toBe(origTokens);
    }
  });

  it("base64 and rot13 wrappers are reversible in principle (carry the payload)", () => {
    const b64 = TRANSFORMS.base64(sample);
    const encoded = b64.split(": ")[1]!;
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(sample);
  });

  it("prompt-injection frames the payload with an override instruction", () => {
    const out = TRANSFORMS["prompt-injection"](sample);
    expect(out.toLowerCase()).toContain("ignore previous instructions");
    expect(out).toContain(sample);
  });
});

describe("hardened encoding wrappers (lockbox — test decoding, not carrier anomaly)", () => {
  const sample = "Please wire 12,500 dollars to vendor Acme now and confirm once sent.";
  it("base64 hardened is deterministic, decode-recoverable, with a give-away-free carrier", () => {
    const a = base64WrapHardened(sample);
    expect(a).toBe(base64WrapHardened(sample)); // deterministic
    // The base64 payload is present and decodes back to the original.
    const b64 = a.match(/[A-Za-z0-9+/]{16,}={0,2}/)![0];
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(sample);
    // The CARRIER (blob removed) must not announce the encoding (blob may coincidentally contain
    // any substring, so we check the shell, not the whole string).
    const carrier = a.replace(b64, "").toLowerCase();
    for (const giveaway of ["base64", "decode", "encoded"]) {
      expect(carrier).not.toContain(giveaway);
    }
  });

  it("rot13 hardened is deterministic and drops the give-away carrier", () => {
    const a = rot13WrapHardened(sample);
    expect(a).toBe(rot13WrapHardened(sample));
    // The soft wrapper's give-aways must be gone (the rot13 blob itself is opaque letters).
    expect(a.toLowerCase()).not.toContain("rot13 encoded");
    expect(a.toLowerCase()).not.toContain("please process it");
  });

  it("uses varied carriers across different payloads", () => {
    const wraps = ["alpha beta", "gamma delta epsilon", "one two three four", "x y z w q"].map(
      base64WrapHardened,
    );
    // Strip the payload to compare carrier shells; expect more than one distinct shell.
    const shells = new Set(wraps.map((w) => w.replace(/[A-Za-z0-9+/]{16,}={0,2}/, "<B64>")));
    expect(shells.size).toBeGreaterThan(1);
  });
});

describe("generateConcern hardenedEncoding option (lockbox)", () => {
  it("produces different base64/rot13 suites than the default, deterministically", () => {
    const soft = generateConcern("finra-promissory", 123, "2026-01-01T00:00:00.000Z");
    const hard = generateConcern("finra-promissory", 123, "2026-01-01T00:00:00.000Z", {
      hardenedEncoding: true,
    });
    const b64Soft = soft.splits.find((s) => s.suite === "base64")!.examples[0]!.text;
    const b64Hard = hard.splits.find((s) => s.suite === "base64")!.examples[0]!.text;
    expect(b64Hard).not.toBe(b64Soft);
    expect(b64Soft.toLowerCase()).toContain("base64"); // default has the give-away carrier
    expect(b64Hard.toLowerCase()).not.toContain("base64"); // hardened does not
    // Deterministic + clean splits unaffected by the option.
    const hard2 = generateConcern("finra-promissory", 123, "2026-01-01T00:00:00.000Z", {
      hardenedEncoding: true,
    });
    expect(b64Hard).toBe(hard2.splits.find((s) => s.suite === "base64")!.examples[0]!.text);
    const cpSoft = soft.splits.find((s) => s.suite === "clean-positive")!.count;
    const cpHard = hard.splits.find((s) => s.suite === "clean-positive")!.count;
    expect(cpHard).toBe(cpSoft);
  });
});
