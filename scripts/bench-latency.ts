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
import { loadDefaultRegistry } from "../packages/judge/src/index.js";
import { VerdictCascade, DEFAULT_PACK_BINDINGS } from "../packages/cascade/src/index.js";

const TOTAL = Number(process.argv[2] ?? 60_000);
const CONCURRENCY = Number(process.argv[3] ?? 16);
const DEADLINE_MS = 800;
const now = new Date("2026-04-01T00:00:00.000Z");

const engine = new VerdictEngine({ deadlineMs: DEADLINE_MS });
const registry = loadDefaultRegistry();
const cascade = new VerdictCascade({ engine, registry, deadlineMs: DEADLINE_MS, packs: DEFAULT_PACK_BINDINGS });

const WORKLOAD: VerdictRequest[] = [
  mk("email.send", { body: "Thanks for reaching out, your statement is attached." }, {}),
  mk("email.send", { body: "We guarantee a 20% return with no risk, guaranteed profits!" }, {}),
  mk("message.send", { body: "Patient John Smith was diagnosed with HIV and started therapy." }, {}),
  mk("payment.transfer", { amount: 9800, body: "Wire 9800 to the vendor account now." }, { reversibility: "irreversible" }),
  mk("payment.transfer", { amount: 30000 }, {
    reversibility: "irreversible",
    mandate: { id: "m1", scope: "pay", limits: { maxAmount: 25000 }, grantor: "cfo", expiresAt: null, version: "1" },
  }),
  mk("crm.update", { record: "lead-42" }, {}),
];

function mk(type: string, payload: Record<string, unknown>, opts: { reversibility?: "reversible" | "irreversible"; mandate?: unknown }): VerdictRequest {
  return {
    tenantId: "bench",
    action: { type, agentId: "a", payload, emittedAt: now.toISOString() },
    liability: {
      mandate: (opts.mandate as VerdictRequest["liability"]["mandate"]) ?? null,
      oversightMode: "autonomous",
      blastRadius: { financialAmount: Number(payload.amount ?? 0), currency: "USD", reversibility: opts.reversibility ?? "reversible" },
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
  const latencies: number[] = new Array(TOTAL);
  const perTierTotals: Record<string, number> = { "1": 0, "2": 0, "3": 0 };
  const perTierCounts: Record<string, number> = { "1": 0, "2": 0, "3": 0 };
  let next = 0;

  console.log(`Running ${TOTAL} verdicts at concurrency ${CONCURRENCY} (deadline ${DEADLINE_MS}ms)…`);
  const wallStart = process.hrtime.bigint();

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= TOTAL) return;
      const r = WORKLOAD[i % WORKLOAD.length]!;
      const t0 = process.hrtime.bigint();
      const v = await cascade.evaluate(r, now);
      latencies[i] = Number(process.hrtime.bigint() - t0) / 1e6;
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
  console.log(`requests:        ${TOTAL}`);
  console.log(`wall time:       ${(wallMs / 1000).toFixed(2)} s`);
  console.log(`throughput:      ${rate.toFixed(0)} verdicts/sec  (target 1000)`);
  console.log(`p50:             ${percentile(latencies, 50).toFixed(3)} ms`);
  console.log(`p95:             ${percentile(latencies, 95).toFixed(3)} ms`);
  console.log(`p99:             ${percentile(latencies, 99).toFixed(3)} ms  (budget ${DEADLINE_MS} ms)`);
  console.log(`max:             ${latencies[latencies.length - 1]!.toFixed(3)} ms`);
  console.log(`\nper-tier average latency (ms):`);
  for (const tier of ["1", "2", "3"]) {
    const avg = perTierCounts[tier] ? perTierTotals[tier]! / perTierCounts[tier]! : 0;
    console.log(`  tier ${tier}: ${avg.toFixed(4)} ms  (${perTierCounts[tier]} samples)`);
  }
  const p99 = percentile(latencies, 99);
  const pass = p99 < DEADLINE_MS && rate >= 1000;
  console.log(`\nResult: ${pass ? "PASS ✅" : "REVIEW ⚠️"}  (p99 ${p99.toFixed(2)}ms ${p99 < DEADLINE_MS ? "<" : ">="} ${DEADLINE_MS}ms, ${rate.toFixed(0)} vps ${rate >= 1000 ? ">=" : "<"} 1000)`);
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
