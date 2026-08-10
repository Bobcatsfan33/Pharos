# Verdict latency benchmark

**Production objective:** p99 end-to-end verdict latency below 800 ms at a sustained aggregate
1,000 verdicts/second. A deployment may satisfy the aggregate rate with horizontally scaled
replicas, but the target topology must be load-tested and accepted as a whole.

Run the production-faithful benchmark with:

```bash
PHAROS_JUDGE_MODEL_DIR=/approved/model-cache pnpm bench:latency [requests] [concurrency]
```

The default provider is `onnx`. The harness preloads and warms all three hash-pinned models, then
drives the real cascade over benign communications, promissory language, PHI, funds movement, and
mandate-limit blocks. Set `PHAROS_BENCH_OUTPUT=report.json` for the machine-readable result. The
linear development baseline is available only through the explicit
`PHAROS_BENCH_JUDGE_PROVIDER=linear` override.

## Current engineering reference

The committed [machine-readable run](onnx-local-reference.json) used:

- Apple M2, 8 GiB RAM, Darwin arm64, Node 25.9.0;
- `onnxruntime-node@1.20.1` with the three models in `packages/judge/models/manifest.json`;
- 120 mixed verdicts at concurrency 2 after preload and warm-up.

| Metric | Measured | Objective | Result |
|---|---:|---:|---|
| p50 | 376.4 ms | — | informational |
| p95 | 435.7 ms | — | informational |
| p99 | 597.2 ms | < 800 ms | pass on this run |
| throughput | 8.1 verdicts/sec | ≥ 1,000 verdicts/sec | **fail** |
| deadline breaches | 0 / 120 | 0 | pass on this run |

This is evidence about one developer host, not a production capacity claim. It demonstrates that
the three-model cascade can remain inside the per-request envelope at low concurrency, while also
showing that a single CPU process is nowhere near the aggregate throughput objective. A
concurrency-16 diagnostic saturated the same host (approximately 8 verdicts/sec, p99 approximately
3.55 seconds) and exercised the deadline path. The cascade now both races a timer and re-checks
monotonic wall time after native inference returns, preventing event-loop starvation from releasing
an expired normal verdict.

## Status of S7-T1

The old p99 3.7 ms / approximately 5,400 verdicts/sec result came from linear bag-of-words judges
and has been retired as a product headline. The benchmark now loads ONNX by default and fails its
process when either the latency or throughput objective is missed.

S7-T1 remains open because the required production Linux CPU/memory/replica topology has not been
selected or load-tested. Its acceptance evidence must include cold and warm startup, saturation and
back-pressure, a sustained run at the aggregate target, zero unaccounted deadline breaches, and an
observed fail-mode/rollback exercise. Extrapolating the developer-host rate into a replica count is
capacity-planning input, not approval evidence.

## Scope

The benchmark measures verdict computation through Tiers 1–3. Transactional sealing to Postgres
and WORM storage is a separate durability path and is not included in the 800 ms verdict budget.
Every Tier-3 verdict identifies the exact model and ONNX runtime used; model startup is measured
separately and excluded from request latency.
