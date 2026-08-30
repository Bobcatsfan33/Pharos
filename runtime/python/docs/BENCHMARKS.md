# KEEL benchmarks

Reproduce: `python -m bench.run_benchmarks` (from the repo root, with `.[dev,viewer]`).
All KEEL numbers below are measured on this machine; competitor columns are TODO
(they need the frameworks installed and an identical workload — not fabricated here).

| Metric | KEEL | CrewAI | LangGraph |
|--------|------|--------|-----------|
| Run latency p50 / p95 / p99 (8-node graph, 300 runs) | 1.24 / 1.46 / 1.52 ms | TODO | TODO |
| Trace overhead (p50, best-of-3, median) | 0.23% / 3µs per run | n/a (no native tracing) | TODO |
| Viewer render (9002 events) | 117 ms | n/a | n/a |
| Context-compiler token reduction | 86% | TODO | TODO |
| Crash-resume (1002-event run) | 2 ms | not durable | TODO |
| Durability (kill-9 mid-run -> resume) | yes, no re-billing | no | partial |
| Multi-worker soak (crashes, lease steal) | clean, 0 re-bills | no | partial |
| Budget enforcement (no-bypass) | yes (emit chokepoint) | no | no |

Notes:
- Run latency is end-to-end wall time per run on the traced in-memory runtime
  (`python -m bench.latency`); the runtime adds microseconds — real latency is
  model-bound.
- Trace overhead is traced-runtime vs a /dev/null sink; tracing cannot be disabled.
- Token reduction is the staged context compiler vs naive concatenation.
- The soak row is `python -m tests.chaos.soak`; the full 24h operational run is the same
  harness with `KEEL_SOAK_DURATION_S=86400`. Durability/budget rows are capability
  comparisons, not timings.
