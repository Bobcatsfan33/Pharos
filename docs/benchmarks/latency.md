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

## Judge path (D1)

Workstream D1 of the [judgement-family handoff](../handoff/2026-10-29-judgement-family-and-primitives.md)
added a typed judge panel: content models run only for the action types their pack binds
(`PHAROS_JUDGE_ROUTING=strict`, the default), a deterministic structural judge runs on every
Tier-3 action, and the applicable judges run concurrently under the cascade deadline. Each
judge's own time is sealed beside the tier total as `verdict.latency.perTier["3/<judgeId>"]`.

Run it with:

```bash
PHAROS_BENCH_OUTPUT=docs/benchmarks/d1-judge-path.json pnpm bench:judge-path [requests]
```

The committed [machine-readable run](d1-judge-path.json) used the same host class as the
reference above (Apple M2, 8 GiB, Darwin arm64, Node 25.9.0) with
`onnxruntime-node@1.30.0/darwin-arm64` and the three hash-pinned models, preloaded and warmed
(preload excluded).

**A. No applicable models** — `crm.update`, 1,000 verdicts, strict routing. Only the
structural judge runs; no content model is loaded onto the request path.

| Metric | Measured | Gate | Result |
|---|---:|---:|---|
| judge path (`perTier["3"]`) p50 | 0.017 ms | — | informational |
| judge path p95 | 0.033 ms | — | informational |
| judge path p99 | 0.074 ms | < 20 ms | **pass** |
| judge path max | 1.559 ms | — | informational |
| whole verdict (Tiers 1–3) p99 | 0.080 ms | — | informational |
| content models run | 0 / 1,000 | 0 | pass |

**B. Three-model path** — `email.send`, 200 verdicts, `routing: all` so every model applies.
Each verdict records the tier wall time and the three per-judge timings.

| Metric | p50 | p99 |
|---|---:|---:|
| `3/finra-promissory` | 171.9 ms | 234.2 ms |
| `3/phi-in-context` | 211.7 ms | 274.4 ms |
| `3/funds-movement-intent` | 230.7 ms | 291.9 ms |
| tier 3 wall (`perTier["3"]`) | 230.9 ms | 292.1 ms |
| max(judge) | 230.7 ms | 291.9 ms |
| sum(judges) | 614.7 ms | 800.0 ms |
| tier 3 ÷ sum(judges) | 0.37 | 0.40 |

Tier-3 wall time tracks the slowest judge to within a fraction of a millisecond at both
percentiles; a serial panel would sit at the sum. Gate: **pass**.

What this does and does not show. The per-judge figures were measured while the three ONNX
sessions shared the same eight cores, so `sum(judges)` overstates what a strictly serial run
would cost; the honest claim is "tier 3 ≈ max(judge)", not a 2.7× speed-up. The no-model path
is fast because routing keeps the transformers off it entirely, which is a change in which
models run for which action types (see [decision-cascade.md](../decision-cascade.md)), not a
change in model speed. Nothing here moves the production throughput gate above, promotes a
judge, or alters the 800 ms objective. Sealing is still outside the measured window.

## Tier-1 mandate-token path (Workstream A)

Workstream A of the [judgement-family handoff](../handoff/2026-10-29-judgement-family-and-primitives.md)
added portable, attenuable MandateTokens. On the request path a presented token costs one root
signature verification, one Ed25519 verification per attenuation block, the proof check, and the
Tier-1 rules. This row measures exactly that and nothing else: no Tier 2/3, no sealing.

Run it with:

```bash
PHAROS_BENCH_OUTPUT=docs/benchmarks/mandate-token.json pnpm bench:mandate-token [verdicts]
```

The committed [machine-readable run](mandate-token.json) used the same host class as the
reference above (Apple M2, Node v25.9.0) with a 2-block token
(4 signatures verified per verdict), alternating an in-limit allow and
an over-ceiling block.

| Metric | Measured | Gate | Result |
|---|---:|---:|---|
| throughput, single process | 3,040 verdicts/s | ≥ 1,000 verdicts/s | **pass** |
| latency p50 | 0.320 ms | — | informational |
| latency p95 | 0.367 ms | — | informational |
| latency p99 | 0.555 ms | — | informational |
| latency max | 1.562 ms | — | informational |

The same gate runs on the CI runner as the `tier1-token-bench` job and fails the build below
1,000 verdicts/s. This is a Tier-1-only number: it says nothing about the judge headline above,
the throughput gate, or the D1 judge-path section, none of which it changes.
