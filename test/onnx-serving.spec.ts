import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOnnxJudge, ModelRegistry } from "@pharos/judge";

/**
 * LIVE serving conformance (network + the real ONNX blob) — excluded from the default suite (named
 * *.spec.ts, run via `pnpm test:live`). Proves:
 *   1. Node serving reproduces the Python training-side scorer: input_ids bit-identical AND
 *      probability within 1e-4 (test/fixtures/onnx-parity.json).
 *   2. A served ONNX judge integrates through ModelRegistry.judgeAsync.
 *   3. Latency — cold load (fetch-cached + sha256 re-verify + session create + first inference)
 *      reported SEPARATELY from warm p50/p99 (the fp32-phi cold re-hash is the 800ms-envelope risk).
 */
interface ParityFixture {
  concern: string;
  temperature: number;
  threshold: number;
  maxLen: number;
  records: { text: string; inputIds: number[]; probability: number }[];
}

const staticFixturePaths = [
  fileURLToPath(new URL("./fixtures/onnx-parity.json", import.meta.url)),
  fileURLToPath(new URL("./fixtures/onnx-parity-funds.json", import.meta.url)),
];
const fixturePaths =
  process.env.PHAROS_ONNX_PARITY_REFERENCES?.split(",") ??
  (process.env.PHAROS_ONNX_PARITY_REFERENCE
    ? [process.env.PHAROS_ONNX_PARITY_REFERENCE]
    : staticFixturePaths);
const fixtures = fixturePaths.map(
  (path) => JSON.parse(readFileSync(path, "utf8")) as ParityFixture,
);

const cacheDir =
  process.env.PHAROS_ONNX_CACHE_DIR ?? mkdtempSync(join(tmpdir(), "pharos-onnx-live-"));

describe("ONNX serving — live parity + latency", () => {
  it("reproduces Python input_ids exactly and probability within 1e-4", async () => {
    for (const fixture of fixtures) {
      const judge = await loadOnnxJudge({ concern: fixture.concern, cacheDir });
      for (const r of fixture.records) {
        const enc = judge.encode(r.text);
        const n = enc.attentionMask.filter((m) => m === 1).length;
        expect(enc.inputIds.slice(0, n), `${fixture.concern} input_ids for: ${r.text}`).toEqual(
          r.inputIds,
        );
      }
      const results = await judge.scoreBatch(fixture.records.map((r) => r.text));
      results.forEach((res, i) => {
        const expected = fixture.records[i]!.probability;
        const delta = Math.abs(res.probability - expected);
        expect(
          delta,
          `${fixture.concern}/${fixture.records[i]!.text}: node=${res.probability} python=${expected} delta=${delta}`,
        ).toBeLessThan(1e-4);
        expect(res.judgeRuntime).toMatch(/^onnxruntime-node@\d+\.\d+\.\d+\/[a-z0-9_-]+$/);
      });
    }
  }, 120_000);

  it("integrates through ModelRegistry.judgeAsync", async () => {
    for (const fixture of fixtures) {
      const registry = new ModelRegistry();
      const judge = await loadOnnxJudge({ concern: fixture.concern, cacheDir });
      registry.registerServed(judge);
      const r = await registry.judgeAsync(fixture.concern, fixture.records[0]!.text);
      expect(r.judgeVersion).toBe(judge.version());
      expect(r.judgeRuntime).toBeDefined();
      expect(r.probability).toBeCloseTo(fixture.records[0]!.probability, 4);
    }
  }, 120_000);

  it("publishes cold-load-with-verify vs warm p50/p99 latency", async () => {
    for (const concern of ["finra-promissory", "phi-in-context", "funds-movement-intent"]) {
      const t0 = performance.now();
      const judge = await loadOnnxJudge({ concern, cacheDir }); // fetch(cached)+sha256 re-verify+session
      await judge.scoreBatch(["warmup"]);
      const coldMs = performance.now() - t0;

      const warm: number[] = [];
      for (let i = 0; i < 30; i++) {
        const s = performance.now();
        await judge.scoreBatch(["We guarantee a fixed return, no risk."]);
        warm.push(performance.now() - s);
      }
      warm.sort((a, b) => a - b);
      const p = (q: number) => warm[Math.min(warm.length - 1, Math.floor(q * warm.length))]!;
      console.log(
        `[latency] ${concern}: cold-load+verify ${coldMs.toFixed(0)}ms · warm p50 ${p(0.5).toFixed(1)}ms · p99 ${p(0.99).toFixed(1)}ms`,
      );
      expect(coldMs).toBeGreaterThan(0);
    }
  }, 300_000);
});
