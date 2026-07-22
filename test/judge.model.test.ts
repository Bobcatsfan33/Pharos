import { describe, it, expect } from "vitest";
import {
  trainJudge,
  modelVersion,
  judge,
  ModelRegistry,
  loadDefaultRegistry,
  type LabeledExample,
} from "@pharos/judge";

const DATA: LabeledExample[] = [
  { text: "guaranteed returns with no risk, you will profit for sure", label: 1 },
  { text: "we guarantee you double your money risk free", label: 1 },
  { text: "promised guaranteed gains that always beat the market", label: 1 },
  { text: "past performance does not guarantee future results", label: 0 },
  { text: "please review the prospectus, investments may lose value", label: 0 },
  { text: "your quarterly statement is attached, contact us", label: 0 },
];

describe("distilled judge model", () => {
  it("learns to separate positive from negative examples", () => {
    const artifact = trainJudge(DATA, { packId: "test-promissory", concern: "promissory" });
    const pos = judge(artifact, "guaranteed risk free returns, sure profit");
    const neg = judge(artifact, "the prospectus discloses that investments may lose value");
    expect(pos.probability).toBeGreaterThan(0.5);
    expect(pos.flagged).toBe(true);
    expect(neg.probability).toBeLessThan(0.5);
    expect(neg.flagged).toBe(false);
  });

  it("produces a deterministic, content-addressed version", () => {
    const a = trainJudge(DATA, { packId: "test-promissory", concern: "promissory" });
    const b = trainJudge(DATA, { packId: "test-promissory", concern: "promissory" });
    expect(modelVersion(a)).toBe(modelVersion(b));
    expect(modelVersion(a)).toMatch(/^test-promissory@[0-9a-f]{12}$/);
  });

  it("registry serves a pack and reports its active version", () => {
    const registry = new ModelRegistry();
    const artifact = trainJudge(DATA, { packId: "test-promissory", concern: "promissory" });
    const version = registry.register(artifact);
    expect(registry.has("test-promissory")).toBe(true);
    expect(registry.activeVersion("test-promissory")).toBe(version);
    const result = registry.judge("test-promissory", "guaranteed profit risk free");
    expect(result.judgeVersion).toBe(version);
  });

  it("ships trained models for the three shipped packs", () => {
    const registry = loadDefaultRegistry();
    expect(registry.has("finra-promissory")).toBe(true);
    expect(registry.has("phi-in-context")).toBe(true);
    expect(registry.has("funds-movement-intent")).toBe(true);
    const finra = registry.judge(
      "finra-promissory",
      "We guarantee a 20% return with no risk, guaranteed profits",
    );
    expect(finra.flagged).toBe(true);
  });
});
