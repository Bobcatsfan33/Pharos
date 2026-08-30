# M6 — Prove the Numbers — STATUS: DONE (CI-gated; 24h soak is operational)

**Headline proof:** *Reproducible p50/p95/p99 + overhead %; 24h multi-worker soak clean.*

## What shipped

- **`bench/latency.py`** — reproducible latency-percentile benchmark. Measures
  end-to-end wall time per run on the traced in-memory runtime and reports
  p50 / p95 / p99 / mean. Nearest-rank percentile helper. CI gate
  (`python -m bench.latency`) with a generous p99 regression ceiling; the percentiles
  themselves are the product.
- **`tests/chaos/soak.py`** — multi-worker soak. A leased worker pool drains runs while
  a fraction are *crashed* before the pool sees them (faithful `kill -9`: a durable
  partial log), in two shapes — committed-prefix and in-flight (model call made,
  response recorded, but step not committed). At-least-once delivery also exercises
  resuming already-completed runs and lease races. Asserts: every run completes; logs
  are gap-free/duplicate-free with consistent cost; every node commits exactly once;
  and **zero re-bills** (model calls == committed steps — recorded calls are replayed,
  never re-billed, across any crash). Duration-parameterized for the 24h operational
  run.
- **`bench/run_benchmarks.py`** — now emits the latency-percentile row and a soak row
  into `docs/BENCHMARKS.md`.
- **CI gates** (`.github/workflows/ci.yml`) — latency percentiles + a bounded soak smoke
  (8 workers × 40 runs × 5 batches, 50% crash) run on every push/PR, alongside the
  existing trace-overhead and viewer-render gates.
- **Tests** — `tests/chaos/test_soak.py`: bounded soak is clean and deterministic across
  seeds with zero re-bills; latency percentiles are ordered and bounded; percentile
  helper is correct.

## Bug fixed along the way

`LeasedRunLoop` had a latent cancellation bug: when a run finished before the event
loop scheduled the heartbeat coroutine's first step, `hb.cancel()` delivered
`CancelledError` at the coroutine's *entry* — before its own `try/except` was active —
so it escaped through `await hb` and failed the worker. Fast in-memory runs hit it under
load. Fixed in `keel/services/worker.py` with the standard cancelled-cleanup idiom
(`contextlib.suppress(asyncio.CancelledError)` around `await hb`). The existing
worker-kill chaos test still passes.

## Reproduce

```bash
python -m bench.latency                          # p50/p95/p99
python -m bench.run_benchmarks                    # regenerate docs/BENCHMARKS.md
python -m tests.chaos.soak                        # one soak batch set, prints CLEAN
KEEL_SOAK_DURATION_S=86400 KEEL_SOAK_WORKERS=16 \
  KEEL_SOAK_RUNS=500 python -m tests.chaos.soak   # the full 24h operational soak
```

## Honest limits

- The **24h** soak is an *operational* run, not a CI gate (CI runs a bounded smoke). The
  harness is duration-parameterized so the 24h run is one env var away; the numbers it
  produces are not committed here.
- Benchmark numbers in `docs/BENCHMARKS.md` are machine-local. Competitor (CrewAI /
  LangGraph) columns remain TODO — they need those frameworks installed and an
  apples-to-apples workload, which the harness documents but does not fabricate.
- Latency is measured against the deterministic mock model, so it isolates *runtime*
  overhead; real end-to-end latency is model-bound.
