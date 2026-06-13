import { describe, it, expect } from "vitest";
import { canonicalize, sha256Hex } from "@pharos/core";

describe("canonical serialization", () => {
  it("is independent of key insertion order", () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("drops undefined object properties", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("produces a stable 64-char hex digest", () => {
    const h = sha256Hex({ hello: "world" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic across runs.
    expect(sha256Hex({ hello: "world" })).toBe(h);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ x: Number.POSITIVE_INFINITY })).toThrow();
  });
});
