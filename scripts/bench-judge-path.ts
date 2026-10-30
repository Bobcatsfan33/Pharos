/**
 * D1 judge-path benchmark — the two exit-gate numbers for Workstream D1.
 *
 *   pnpm bench:judge-path [requests]
 *
 *   A. "no applicable models": a `crm.update` under strict routing runs only the structural
 *      judge. Gate: judge-path p99 (perTier["3"]) < 20 ms.
 *   B. "three-model path": an `email.send` with routing "all" runs all three content models
 *      concurrently. Evidence: per verdict, tier-3 wall time versus the SUM of the three
 *      per-judge timings. A serial panel would show ratio ≈ 1; a concurrent one ≈ 1/3 … 1/2.
 *
 * Judges are the hash-pinned ONNX transformers by default (PHAROS_JUDGE_MODEL_DIR or the default
 * cache); PHAROS_BENCH_JUDGE_PROVIDER=linear uses the logistic baseline. Models are preloaded
 * and warmed; preload is excluded from request latency. Writes PHAROS_BENCH_OUTPUT when set.
 */
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { VerdictEngine, type VerdictRequest } from "../packages/core/src/index.js";
import {
  loadDefaultRegistry,
  loadOnnxJudge,
  ModelRegistry,
  onnxRuntimeIdentity,
} from "../packages/judge/src/index.js";
import { VerdictCascade, DEFAULT_PACK_BINDINGS } from "../packages/cascade/src/index.js";

const REQUESTS = Number(process.argv[2] ?? 1000);
const PROVIDER = process.env.PHAROS_BENCH_JUDGE_PROVIDER ?? "onnx";
const OUTPUT = process.env.PHAROS_BENCH_OUTPUT;
const DEADLINE_MS = 800;
const NO_MODEL_GATE_MS = 20;
const now = new Date("2026-10-29T00:00:00.000Z");

const req = (type: string, payload: Record<string, unknown>): VerdictRequest => ({
  tenantId: "bench",
  action: { type, agentId: "a", payload, emittedAt: now.toISOString() },
  liability: {
    mandate: null,
    oversightMode: "autonomous",
    blastRadius: { financialAmount: 0, currency: "USD", reversibility: "reversible" },
    modelMetadata: null,
  },
});
const NO_MODEL = req("crm.update", { record: "lead-42", note: "Thanks for the call today." });
const THREE_MODEL = req("email.send", {
  body: "Thanks for reaching out, your statement is attached and the transfer completed.",
});

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    p50: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: s[s.length - 1] ?? 0,
    n: s.length,
  };
};

async function registry(): Promise<ModelRegistry> {
  if (PROVIDER === "linear") return loadDefaultRegistry();
  const r = new ModelRegistry();
  const judges = await Promise.all(
    DEFAULT_PACK_BINDINGS.map((b) => loadOnnxJudge({ concern: b.packId, packId: b.packId })),
  );
  await Promise.all(judges.map((j) => j.scoreBatch(["warmup"])));
  for (const j of judges) r.registerServed(j);
  return r;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const reg = await registry();
  const preloadMs = performance.now() - t0;
  const engine = new VerdictEngine({ deadlineMs: DEADLINE_MS });
  const strict = new VerdictCascade({
    engine,
    registry: reg,
    deadlineMs: DEADLINE_MS,
    packs: DEFAULT_PACK_BINDINGS,
  });
  const all = new VerdictCascade({
    engine,
    registry: reg,
    deadlineMs: DEADLINE_MS,
    packs: DEFAULT_PACK_BINDINGS,
    routing: "all",
  });

  // A. no applicable models (strict routing, crm.update)
  const t3NoModel: number[] = [];
  const totalNoModel: number[] = [];
  let modelsRan = 0;
  for (let i = 0; i < REQUESTS; i++) {
    const v = await strict.evaluate(NO_MODEL, now);
    t3NoModel.push(v.latency.perTier["3"] ?? 0);
    totalNoModel.push(v.latency.totalMs);
    if (Object.keys(v.latency.perTier).some((k) => k.startsWith("3/") && k !== "3/structural"))
      modelsRan += 1;
  }

  // B. three-model path (routing all, email.send): tier-3 wall vs sum of per-judge
  const t3Three: number[] = [];
  const sumJudges: number[] = [];
  const maxJudge: number[] = [];
  const ratios: number[] = [];
  const perJudge: Record<string, number[]> = {};
  const three = Math.min(REQUESTS, PROVIDER === "onnx" ? 200 : REQUESTS);
  for (let i = 0; i < three; i++) {
    const v = await all.evaluate(THREE_MODEL, now);
    const judges = Object.entries(v.latency.perTier).filter(
      ([k]) => k.startsWith("3/") && k !== "3/structural",
    );
    if (judges.length !== 3)
      throw new Error(`expected 3 content judges, got ${judges.map(([k]) => k).join(",")}`);
    const sum = judges.reduce((s, [, ms]) => s + ms, 0);
    const mx = Math.max(...judges.map(([, ms]) => ms));
    for (const [k, ms] of judges) (perJudge[k] ??= []).push(ms);
    t3Three.push(v.latency.perTier["3"]!);
    sumJudges.push(sum);
    maxJudge.push(mx);
    ratios.push(v.latency.perTier["3"]! / sum);
  }

  const a = stats(t3NoModel);
  const aTotal = stats(totalNoModel);
  const b = {
    tier3: stats(t3Three),
    sumOfJudges: stats(sumJudges),
    maxJudge: stats(maxJudge),
    ratioTier3OverSum: stats(ratios),
  };
  const gateA = a.p99 < NO_MODEL_GATE_MS && modelsRan === 0;
  const gateB = b.ratioTier3OverSum.p50 < 0.75; // concurrent: well below the serial ratio of 1
  const out = {
    schemaVersion: "1.0.0",
    workstream: "D1",
    provider: PROVIDER,
    runtime: PROVIDER === "onnx" ? onnxRuntimeIdentity() : "logistic",
    models: reg.listVersions(),
    host: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      node: process.version,
    },
    preloadMs,
    noApplicableModels: {
      requests: REQUESTS,
      action: NO_MODEL.action.type,
      judgePathMs: a,
      verdictTotalMs: aTotal,
      contentModelsRan: modelsRan,
      gate: { judgePathP99BelowMs: NO_MODEL_GATE_MS, pass: gateA },
    },
    threeModelPath: {
      requests: three,
      action: THREE_MODEL.action.type,
      perJudgeMs: Object.fromEntries(Object.entries(perJudge).map(([k, v]) => [k, stats(v)])),
      ...b,
      gate: { description: "tier-3 wall time ≈ max(model), not sum(model)", pass: gateB },
    },
  };
  console.log(
    `\n=== D1 judge-path benchmark (${PROVIDER}${PROVIDER === "onnx" ? `, ${onnxRuntimeIdentity()}` : ""}) ===`,
  );
  console.log(`preload + warm: ${preloadMs.toFixed(0)} ms (excluded)`);
  console.log(
    `\nA. no applicable models — ${NO_MODEL.action.type}, ${REQUESTS} verdicts, strict routing`,
  );
  console.log(
    `   judge path p50/p95/p99/max: ${a.p50.toFixed(3)} / ${a.p95.toFixed(3)} / ${a.p99.toFixed(3)} / ${a.max.toFixed(3)} ms   content models ran: ${modelsRan}`,
  );
  console.log(
    `   whole verdict p99: ${aTotal.p99.toFixed(3)} ms   gate p99 < ${NO_MODEL_GATE_MS} ms: ${gateA ? "PASS" : "FAIL"}`,
  );
  console.log(`\nB. three-model path — ${THREE_MODEL.action.type}, ${three} verdicts, routing all`);
  for (const [k, s] of Object.entries(out.threeModelPath.perJudgeMs))
    console.log(`   ${k.padEnd(26)} p50 ${s.p50.toFixed(1)} ms  p99 ${s.p99.toFixed(1)} ms`);
  console.log(`   tier 3 wall  p50 ${b.tier3.p50.toFixed(1)} ms  p99 ${b.tier3.p99.toFixed(1)} ms`);
  console.log(
    `   sum(judges)  p50 ${b.sumOfJudges.p50.toFixed(1)} ms   max(judge) p50 ${b.maxJudge.p50.toFixed(1)} ms`,
  );
  console.log(
    `   tier3 / sum  p50 ${b.ratioTier3OverSum.p50.toFixed(2)}  (serial would be ≈ 1.00)   gate: ${gateB ? "PASS" : "FAIL"}`,
  );
  if (OUTPUT) writeFileSync(OUTPUT, `${JSON.stringify(out, null, 2)}\n`);
  if (!gateA || !gateB) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
