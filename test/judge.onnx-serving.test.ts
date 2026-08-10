import { describe, it, expect } from "vitest";
import {
  OnnxJudge,
  BertTokenizer,
  ModelRegistry,
  type OnnxSession,
  type TensorCtor,
  type TokenizerConfig,
  onnxRuntimeIdentity,
  assertQualifiedOnnxRuntime,
  loadManifest,
} from "@pharos/judge";

/**
 * Hermetic serving-contract test with a MOCK ONNX session (no model download). Proves the ONNX
 * judge maps logits → calibrated probability → JudgeResult correctly, and that the registry is
 * polymorphic (judgeAsync dispatches to a served async judge). Real bit-parity + latency live in
 * test/onnx-serving.spec.ts.
 */
const cfg: TokenizerConfig = {
  vocab: { "[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, flag: 4, ok: 5 },
  unkToken: "[UNK]",
  continuingSubwordPrefix: "##",
  maxInputCharsPerWord: 100,
  cls: "[CLS]",
  sep: "[SEP]",
  pad: "[PAD]",
  lowercase: false,
  handleChineseChars: true,
};

// A fake Tensor (records nothing) and a session that returns logits based on the batch size.
const FakeTensor: TensorCtor = class {
  constructor(
    public type: "int64",
    public data: BigInt64Array,
    public dims: number[],
  ) {}
} as unknown as TensorCtor;

// scoreBatch runs one (batch-1) inference per text; the mock returns successive rows in order.
function sessionReturning(perRowLogits: [number, number][]): OnnxSession {
  let call = 0;
  return {
    async run() {
      const row = perRowLogits[call++]!;
      return { logits: { data: new Float32Array(row) } };
    },
  };
}

function makeJudge(perRow: [number, number][], threshold = 0.5, temperature = 1) {
  return new OnnxJudge(
    "demo",
    "demo",
    sessionReturning(perRow),
    FakeTensor,
    new BertTokenizer(cfg),
    {
      modelVersion: "demo@abc123def456",
      temperature,
      threshold,
      maxLen: 8,
    },
  );
}

describe("OnnxJudge serving contract", () => {
  it("maps logits → softmax(pos) probability and applies the threshold", async () => {
    // logit row [0, 2.1972] → softmax pos = e^2.1972/(1+e^2.1972) ≈ 0.9.
    const judge = makeJudge([
      [0, 2.1972],
      [2.1972, 0],
    ]);
    const [a, b] = await judge.scoreBatch(["flag flag", "ok ok"]);
    expect(a!.probability).toBeCloseTo(0.9, 3);
    expect(a!.flagged).toBe(true);
    expect(b!.probability).toBeCloseTo(0.1, 3);
    expect(b!.flagged).toBe(false);
    expect(a!.judgeVersion).toBe("demo@abc123def456");
    expect(a!.judgeRuntime).toBe(onnxRuntimeIdentity());
    expect(a!.packId).toBe("demo");
  });

  it("applies temperature scaling to the probability", async () => {
    const hot = await makeJudge([[0, 2]], 0.5, 1).scoreBatch(["x"]);
    const cold = await makeJudge([[0, 2]], 0.5, 2).scoreBatch(["x"]);
    // Higher temperature (÷2) softens the logit gap → probability closer to 0.5.
    expect(cold[0]!.probability).toBeLessThan(hot[0]!.probability);
    expect(cold[0]!.probability).toBeGreaterThan(0.5);
  });

  it("preserves batch order and returns one result per input", async () => {
    const judge = makeJudge([
      [3, -3],
      [-3, 3],
      [3, -3],
    ]);
    const r = await judge.scoreBatch(["a", "b", "c"]);
    expect(r.map((x) => x.flagged)).toEqual([false, true, false]);
  });
});

describe("ONNX production runtime qualification", () => {
  it("accepts the pinned Linux x64 runtime and refuses unqualified variants", () => {
    const manifest = loadManifest();
    expect(() =>
      assertQualifiedOnnxRuntime(manifest, "onnxruntime-node@1.20.1/linux-x64"),
    ).not.toThrow();
    expect(() => assertQualifiedOnnxRuntime(manifest, "onnxruntime-node@1.27.0/linux-x64")).toThrow(
      /not production-qualified/,
    );
    expect(() =>
      assertQualifiedOnnxRuntime(manifest, "onnxruntime-node@1.20.1/darwin-arm64"),
    ).toThrow(/not production-qualified/);
  });
});

describe("ModelRegistry polymorphism", () => {
  it("registers a served ONNX judge and judgeAsync dispatches to it (version is its content hash)", async () => {
    const registry = new ModelRegistry();
    const judge = makeJudge([[-3, 3]]);
    const version = registry.registerServed(judge);
    expect(version).toBe("demo@abc123def456");
    expect(registry.has("demo")).toBe(true);
    expect(registry.activeVersion("demo")).toBe("demo@abc123def456");
    const result = await registry.judgeAsync("demo", "flag");
    expect(result.flagged).toBe(true);
    expect(result.judgeVersion).toBe("demo@abc123def456");
    // The sync logistic path rejects a served pack (callers use judgeAsync).
    expect(() => registry.judge("demo", "x")).toThrow(/logistic judge/);
    expect(registry.listVersions().some((v) => v.version === "demo@abc123def456")).toBe(true);
  });

  it("judgeAsync still serves a logistic pack synchronously under the hood", async () => {
    const registry = new ModelRegistry();
    registry.register({
      packId: "log",
      concern: "log",
      weights: { "u:flag": 5 },
      bias: -1,
      threshold: 0.5,
      trainedOn: { examples: 0, positives: 0, datasetHash: "x", iterations: 0 },
    });
    const r = await registry.judgeAsync("log", "flag flag flag");
    expect(r.flagged).toBe(true);
  });
});
