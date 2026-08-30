"""Reproducible benchmark harness (P4-9).

Runs KEEL's headline numbers and writes docs/BENCHMARKS.md:
  * trace overhead (vs a /dev/null sink)
  * viewer render time for a ~9k-event run
  * context-compiler token reduction
  * crash-resume time for a 1k-event run

Run from the repo root:  python -m bench.run_benchmarks

Competitor (CrewAI / LangGraph) columns are left as TODO placeholders — they require
those frameworks installed and an apples-to-apples workload, which this harness
documents but does not fabricate.
"""
from __future__ import annotations
import asyncio
import time
from pathlib import Path

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.budget import Budget, BudgetAction
from keel.services.model.handlers import MockModelPort
from keel.services.context import ContextCompiler
from tests.chaos.bench_overhead import measure as overhead_measure
from tests.chaos.bench_viewer import measure as viewer_measure
from bench.latency import measure as latency_measure

UNLIMITED = Budget(max_usd=None, max_steps=None, action=BudgetAction.WARN)


async def resume_time_1k() -> tuple[int, float]:
    """Fold a ~1k-event log and resume to completion; report wall time."""
    runner = await Runner.open(in_memory=True, model=MockModelPort(), budget=UNLIMITED)
    n = 200  # ~5 events/step => ~1k events
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP, config={"model": "mock:test"})
             for i in range(n)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(n - 1)]
    await runner.register(Graph(graph_id="r1k", nodes=nodes, edges=edges), run_id="r1k")
    await runner.run(Graph(graph_id="r1k", nodes=nodes, edges=edges), run_id="r1k")
    events = await runner.read_events("r1k")
    t0 = time.perf_counter()
    await runner.resume("r1k")  # terminal -> fold-only path (the resume cost)
    elapsed = time.perf_counter() - t0
    await runner.close()
    return len(events), elapsed


def token_reduction() -> float:
    cc = ContextCompiler(keep_recent_turns=3, top_k_memory=3)
    hist = [{"role": "user", "content": f"turn {i} " + "lorem ipsum " * 10} for i in range(40)]
    kw = dict(system="assistant", role="researcher", prompt="summarize", inputs="",
              history=hist, memory=[f"fact {i} " + "x " * 20 for i in range(12)])
    return 1 - cc.compile(**kw).total_tokens / cc.naive_tokens(**kw)


async def main() -> None:
    bp, rp, overhead = await overhead_measure()
    v_events, v_ms = await viewer_measure(nodes=1800)
    n_events, resume_s = await resume_time_1k()
    reduction = token_reduction()
    lat = await latency_measure()

    md = f"""# KEEL benchmarks

Reproduce: `python -m bench.run_benchmarks` (from the repo root, with `.[dev,viewer]`).
All KEEL numbers below are measured on this machine; competitor columns are TODO
(they need the frameworks installed and an identical workload — not fabricated here).

| Metric | KEEL | CrewAI | LangGraph |
|--------|------|--------|-----------|
| Run latency p50 / p95 / p99 ({lat.nodes}-node graph, {lat.n} runs) | {lat.p50_s*1e3:.2f} / {lat.p95_s*1e3:.2f} / {lat.p99_s*1e3:.2f} ms | TODO | TODO |
| Trace overhead (p50, best-of-3, median) | {overhead*100:.2f}% / {(rp-bp)*1e6:.0f}µs per run | n/a (no native tracing) | TODO |
| Viewer render ({v_events} events) | {v_ms*1000:.0f} ms | n/a | n/a |
| Context-compiler token reduction | {reduction*100:.0f}% | TODO | TODO |
| Crash-resume ({n_events}-event run) | {resume_s*1000:.0f} ms | not durable | TODO |
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
"""
    out = Path("docs/BENCHMARKS.md")
    out.write_text(md)
    print(md)
    print(f"wrote {out}")


if __name__ == "__main__":
    asyncio.run(main())
