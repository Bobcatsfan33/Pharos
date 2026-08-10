import { readFileSync } from "node:fs";
import { type JudgeResult } from "./model.js";
import { BertTokenizer, type Encoding } from "./tokenizer.js";
import { ensureArtifact, type EnsureOptions } from "./artifactStore.js";
import { onnxRuntimeIdentity } from "./runtime.js";

/**
 * Served transformer judge (Sprint 6, S6-T2): an ONNX distilbert classifier run on CPU via
 * onnxruntime-node, behind the EXACT same JudgeResult contract as the logistic judge, so the
 * cascade and registry are polymorphic on artifact kind without any change to their callers. The
 * ONNX + tokenizer blobs are fetched hash-verified from the artifact store; the tokenizer is the
 * bit-parity BertTokenizer. `version()` is the manifest's content-hashed modelVersion (unchanged
 * version-is-content-hash rule).
 *
 * onnxruntime-node is loaded LAZILY (only when an ONNX judge is actually constructed), so the
 * logistic path and the rest of the codebase never load the native addon. The session + Tensor
 * constructor are injected, which also makes the serving contract unit-testable without a model.
 */
export interface AsyncJudge {
  packId: string;
  concern: string;
  version(): string;
  scoreBatch(texts: string[]): Promise<JudgeResult[]>;
}

/** Minimal structural view of the pieces of onnxruntime-node we use (keeps it injectable). */
export interface OnnxTensor {
  data: Float32Array;
}
export type TensorCtor = new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
export interface OnnxSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensor>>;
}

function stableSoftmaxPos(l0: number, l1: number, temperature: number): number {
  const t = Math.max(temperature, 0.05);
  const a = l0 / t;
  const b = l1 / t;
  const m = Math.max(a, b);
  const e0 = Math.exp(a - m);
  const e1 = Math.exp(b - m);
  return e1 / (e0 + e1);
}

export interface OnnxJudgeMeta {
  modelVersion: string;
  temperature: number;
  threshold: number;
  maxLen: number;
}

export class OnnxJudge implements AsyncJudge {
  constructor(
    readonly packId: string,
    readonly concern: string,
    private readonly session: OnnxSession,
    private readonly Tensor: TensorCtor,
    private readonly tokenizer: BertTokenizer,
    private readonly meta: OnnxJudgeMeta,
  ) {}

  version(): string {
    return this.meta.modelVersion;
  }

  /** The exact input_ids/attention_mask fed to the model (exposed for tokenizer-parity checks). */
  encode(text: string): Encoding {
    return this.tokenizer.encode(text, this.meta.maxLen);
  }

  /**
   * Score each text with a SINGLE (batch-1) inference. This is deliberate, not a throughput
   * oversight: dynamic-int8 ONNX computes per-tensor activation scales over the whole input tensor,
   * so a row's logits would depend on its BATCH-MATES — a verdict must be reproducible (evidence,
   * replay), and it must match the single-inference training-side scorer. Batch-1 makes every score
   * independent of batch composition (fp32 is batch-invariant either way). The cascade evaluates one
   * action at a time, so this is also the real serving shape.
   */
  async scoreBatch(texts: string[]): Promise<JudgeResult[]> {
    const { maxLen, temperature, threshold, modelVersion } = this.meta;
    const results: JudgeResult[] = [];
    for (const text of texts) {
      const enc = this.tokenizer.encode(text, maxLen);
      const ids = BigInt64Array.from(enc.inputIds, (v) => BigInt(v));
      const mask = BigInt64Array.from(enc.attentionMask, (v) => BigInt(v));
      const dims = [1, maxLen];
      const out = await this.session.run({
        input_ids: new this.Tensor("int64", ids, dims),
        attention_mask: new this.Tensor("int64", mask, dims),
      });
      const logits = out.logits!.data;
      const probability = stableSoftmaxPos(logits[0]!, logits[1]!, temperature);
      results.push({
        packId: this.packId,
        concern: this.concern,
        judgeVersion: modelVersion,
        judgeRuntime: onnxRuntimeIdentity(),
        probability,
        flagged: probability >= threshold,
        threshold,
      });
    }
    return results;
  }

  async judge(text: string): Promise<JudgeResult> {
    return (await this.scoreBatch([text]))[0]!;
  }
}

export interface LoadOnnxOptions extends EnsureOptions {
  concern: string;
  packId?: string;
}

/** Fetch (hash-verified) + load an ONNX judge: session + parity tokenizer + calibration metadata.
 *  Lazily imports onnxruntime-node so nothing else pays for the native addon. */
export async function loadOnnxJudge(opts: LoadOnnxOptions): Promise<OnnxJudge> {
  const fetched = await ensureArtifact(opts.concern, opts);
  const tokenizer = BertTokenizer.fromJson(JSON.parse(readFileSync(fetched.tokenizerPath, "utf8")));
  // onnxruntime-node ships no resolvable types for the dynamic-import default; pin the shape we use.
  // CJS/ESM interop varies (default vs namespace), so accept either.
  // @ts-expect-error -- no bundled declaration for the module
  const ortModule = await import("onnxruntime-node");
  const ort = (ortModule.default ?? ortModule) as {
    InferenceSession: { create(path: string): Promise<OnnxSession> };
    Tensor: TensorCtor;
  };
  const session = await ort.InferenceSession.create(fetched.modelPath);
  return new OnnxJudge(opts.packId ?? opts.concern, opts.concern, session, ort.Tensor, tokenizer, {
    modelVersion: fetched.modelVersion,
    temperature: fetched.temperature,
    threshold: fetched.threshold,
    maxLen: fetched.maxLen,
  });
}
