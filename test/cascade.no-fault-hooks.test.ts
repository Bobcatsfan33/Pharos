import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cascadePackage from "@pharos/cascade";

/**
 * The production cascade carries no fault-injection path (#82).
 *
 * Previously `CascadeDeps` accepted a `faults` field, so the shipped `VerdictCascade`
 * contained a branch straight into injected failure. That was only reachable via a
 * field the server never set — but "never set" is an operational claim about call
 * sites, not a structural claim about the code, and it is exactly the kind of claim
 * that quietly stops being true.
 *
 * The seam now lives in `FaultInjectingCascade` (`@pharos/cascade/testing`), a subclass
 * that overrides the judge step. These assertions pin that arrangement: the shipped
 * class has no fault branch, and the test-only module is not on the package's public
 * surface.
 */
const cascadeSource = readFileSync(
  fileURLToPath(new URL("../packages/cascade/src/cascade.ts", import.meta.url)),
  "utf8",
);

describe("production cascade has no fault-injection seam", () => {
  it("the shipped module contains no fault hook at all", () => {
    // No dependency field, and no branch that consults one.
    expect(cascadeSource).not.toMatch(/faults\??:/);
    expect(cascadeSource).not.toMatch(/deps\.faults/);
    expect(cascadeSource).not.toMatch(/judgeThrows/);
    expect(cascadeSource).not.toMatch(/judgeDelayMs/);
  });

  it("does not export fault-injection from the package index", () => {
    // An ordinary `import ... from "@pharos/cascade"` cannot reach the seam.
    expect(Object.keys(cascadePackage)).not.toContain("FaultInjectingCascade");
    expect(Object.keys(cascadePackage)).not.toContain("CascadeFaults");
  });

  it("still exposes the production cascade itself", () => {
    // Guards against the negative assertions above passing because the module moved.
    expect(Object.keys(cascadePackage)).toContain("VerdictCascade");
    expect(cascadeSource).toMatch(/export class VerdictCascade/);
  });

  it("the fault subclass is reachable only by explicit deep import", async () => {
    const testing = await import("@pharos/cascade/testing");
    expect(testing.FaultInjectingCascade).toBeTypeOf("function");
    // It really is a VerdictCascade, so tests drive the production code path.
    expect(
      Object.getPrototypeOf(testing.FaultInjectingCascade) === cascadePackage.VerdictCascade,
    ).toBe(true);
  });
});
