/**
 * Verdict-latency benchmark (Sprint 2 — Lantern).
 *
 *   pnpm bench:latency [totalRequests] [concurrency]
 *
 * Drives the real cascade (Tier 1 rules + Tier 2 risk + Tier 3 served judges) over a
 * representative mix of action shapes and reports achieved throughput plus p50/p95/p99/max
 * end-to-end verdict latency and per-tier averages. The exit criterion is p99 < 800ms at a
 * sustained 1,000 verdicts/sec; this harness measures the achievable rate and the tail.
 */
import { VerdictEngine, type VerdictRequest } from "../packages/core/src/index.js";
import { writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { loadDefaultRegistry, loadOnnxJudge, ModelRegistry } from "../packages/judge/src/index.js";
import { VerdictCascade, DEFAULT_PACK_BINDINGS } from "../packages/cascade/src/index.js";

const TOTAL = Number(process.argv[2] ?? 60_000);
const CONCURRENCY = Number(process.argv[3] ?? 16);
const JUDGE_PROVIDER = process.env.PHAROS_BENCH_JUDGE_PROVIDER ?? "onnx";
const OUTPUT = process.env.PHAROS_BENCH_OUTPUT;
const DEADLINE_MS = 800;
const now = new Date("2026-04-01T00:00:00.000Z");

const engine = new VerdictEngine({ deadlineMs: DEADLINE_MS });
async function loadBenchmarkRegistry(): Promise<ModelRegistry> {
  if (JUDGE_PROVIDER === "linear") return loadDefaultRegistry();
  if (JUDGE_PROVIDER !== "onnx") {
    throw new Error("PHAROS_BENCH_JUDGE_PROVIDER must be onnx or linear");
  }
  const registry = new ModelRegistry();
  const judges = await Promise.all(
    DEFAULT_PACK_BINDINGS.map((binding) =>
      loadOnnxJudge({ concern: binding.packId, packId: binding.packId }),
    ),
  );
  await Promise.all(judges.map((judge) => judge.scoreBatch(["warmup"])));
  for (const judge of judges) registry.registerServed(judge);
  return registry;
}

const WORKLOAD: VerdictRequest[] = [
  mk("email.send", { body: "Thanks for reaching out, your statement is attached." }, {}),
  mk("email.send", { body: "We guarantee a 20% return with no risk, guaranteed profits!" }, {}),
  mk(
    "message.send",
    { body: "Patient John Smith was diagnosed with HIV and started therapy." },
    {},
  ),
  mk(
    "payment.transfer",
    { amount: 9800, body: "Wire 9800 to the vendor account now." },
    { reversibility: "irreversible" },
  ),
  mk(
    "payment.transfer",
    { amount: 30000 },
    {
      reversibility: "irreversible",
      mandate: {
        id: "m1",
        scope: "pay",
        limits: { maxAmount: 25000 },
        grantor: "cfo",
        expiresAt: null,
        version: "1",
      },
    },
  ),
  mk("crm.update", { record: "lead-42" }, {}),
];

function mk(
  type: string,
  payload: Record<string, unknown>,
  opts: { reversibility?: "reversible" | "irreversible"; mandate?: unknown },
): VerdictRequest {
  return {
    tenantId: "bench",
    action: { type, agentId: "a", payload, emittedAt: now.toISOString() },
    liability: {
      mandate: (opts.mandate as VerdictRequest["liability"]["mandate"]) ?? null,
      oversightMode: "autonomous",
      blastRadius: {
        financialAmount: Number(payload.amount ?? 0),
        currency: "USD",
        reversibility: opts.reversibility ?? "reversible",
      },
      modelMetadata: null,
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const preloadStart = performance.now();
  const registry = await loadBenchmarkRegistry();
  const preloadMs = performance.now() - preloadStart;
  const cascade = new VerdictCascade({
    engine,
    registry,
    deadlineMs: DEADLINE_MS,
    packs: DEFAULT_PACK_BINDINGS,
  });
  const latencies: number[] = new Array(TOTAL);
  const perTierTotals: Record<string, number> = { "1": 0, "2": 0, "3": 0 };
  const perTierCounts: Record<string, number> = { "1": 0, "2": 0, "3": 0 };
  let next = 0;
  let deadlineBreaches = 0;
  let failOpen = 0;
  let failClosed = 0;

  console.log(
    `Running ${TOTAL} verdicts at concurrency ${CONCURRENCY} (deadline ${DEADLINE_MS}ms)…`,
  );
  const wallStart = process.hrtime.bigint();

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= TOTAL) return;
      const r = WORKLOAD[i % WORKLOAD.length]!;
      const t0 = process.hrtime.bigint();
      const v = await cascade.evaluate(r, now);
      latencies[i] = Number(process.hrtime.bigint() - t0) / 1e6;
      if (v.latency.deadlineBreached) deadlineBreaches += 1;
      if (v.failMode === "fail_open") failOpen += 1;
      if (v.failMode === "fail_closed") failClosed += 1;
      for (const [tier, ms] of Object.entries(v.latency.perTier)) {
        perTierTotals[tier] = (perTierTotals[tier] ?? 0) + ms;
        perTierCounts[tier] = (perTierCounts[tier] ?? 0) + 1;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;

  latencies.sort((a, b) => a - b);
  const rate = (TOTAL / wallMs) * 1000;

  console.log(`\n=== Verdict latency benchmark ===`);
  console.log(`judge provider:  ${JUDGE_PROVIDER}`);
  console.log(`preload + warm:  ${preloadMs.toFixed(0)} ms (excluded from request latency)`);
  console.log(`requests:        ${TOTAL}`);
  console.log(`wall time:       ${(wallMs / 1000).toFixed(2)} s`);
  console.log(`throughput:      ${rate.toFixed(0)} verdicts/sec  (target 1000)`);
  console.log(`p50:             ${percentile(latencies, 50).toFixed(3)} ms`);
  console.log(`p95:             ${percentile(latencies, 95).toFixed(3)} ms`);
  console.log(
    `p99:             ${percentile(latencies, 99).toFixed(3)} ms  (budget ${DEADLINE_MS} ms)`,
  );
  console.log(`max:             ${latencies[latencies.length - 1]!.toFixed(3)} ms`);
  console.log(`deadline breach: ${deadlineBreaches}`);
  console.log(`fail open/closed:${failOpen}/${failClosed}`);
  console.log(`\nper-tier average latency (ms):`);
  for (const tier of ["1", "2", "3"]) {
    const avg = perTierCounts[tier] ? perTierTotals[tier]! / perTierCounts[tier]! : 0;
    console.log(`  tier ${tier}: ${avg.toFixed(4)} ms  (${perTierCounts[tier]} samples)`);
  }
  const p99 = percentile(latencies, 99);
  const pass = p99 < DEADLINE_MS && rate >= 1000;
  console.log(
    `\nResult: ${pass ? "PASS ✅" : "REVIEW ⚠️"}  (p99 ${p99.toFixed(2)}ms ${p99 < DEADLINE_MS ? "<" : ">="} ${DEADLINE_MS}ms, ${rate.toFixed(0)} vps ${rate >= 1000 ? ">=" : "<"} 1000)`,
  );
  if (OUTPUT) {
    const perTierAverageMs = Object.fromEntries(
      ["1", "2", "3"].map((tier) => [
        tier,
        perTierCounts[tier] ? perTierTotals[tier]! / perTierCounts[tier]! : null,
      ]),
    );
    writeFileSync(
      OUTPUT,
      `${JSON.stringify(
        {
          schemaVersion: "1.0.0",
          provider: JUDGE_PROVIDER,
          models: registry.listVersions(),
          host: {
            platform: process.platform,
            arch: process.arch,
            cpu: cpus()[0]?.model ?? "unknown",
            logicalCpus: cpus().length,
            memoryBytes: totalmem(),
            node: process.version,
          },
          workload: { requests: TOTAL, concurrency: CONCURRENCY, deadlineMs: DEADLINE_MS },
          result: {
            preloadMs,
            wallMs,
            throughputVerdictsPerSecond: rate,
            p50Ms: percentile(latencies, 50),
            p95Ms: percentile(latencies, 95),
            p99Ms: p99,
            maxMs: latencies[latencies.length - 1],
            deadlineBreaches,
            failOpen,
            failClosed,
            perTierAverageMs,
          },
          gate: {
            latencyPassed: p99 < DEADLINE_MS,
            throughputPassed: rate >= 1000,
            passed: pass,
          },
        },
        null,
        2,
      )}\n`,
    );
    console.log(`wrote ${OUTPUT}`);
  }
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
