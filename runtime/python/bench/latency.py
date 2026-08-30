"""Reproducible latency-percentile benchmark (M6).

Measures end-to-end wall time per run for a fixed workload on the real (in-memory)
traced runtime, and reports the distribution: p50 / p95 / p99 / mean. Pairs with the
trace-overhead benchmark (traced vs /dev/null sink) so "the numbers" — latency
percentiles *and* overhead % — are produced by a committed harness, not asserted from
memory.

Runnable as a CI gate:  python -m bench.latency
"""
from __future__ import annotations

import asyncio
import math
import sys
import time
from dataclasses import dataclass
from statistics import mean

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort

# A per-run latency above this on a mock model means something is pathologically wrong
# (real work is model-bound, not runtime-bound). The percentiles are the product; this
# ceiling is only a regression backstop and is generous to stay CI-stable.
P99_CEILING_S = 0.050


def percentile(sorted_xs: list[float], q: float) -> float:
    """Nearest-rank percentile of an already-sorted list (q in [0, 100]).

    Rank = ceil(q/100 * n); the value at that 1-based rank. e.g. for 1..100, q=95 -> 95.
    """
    if not sorted_xs:
        return 0.0
    rank = math.ceil((q / 100.0) * len(sorted_xs))
    k = max(0, min(len(sorted_xs) - 1, rank - 1))
    return sorted_xs[k]


@dataclass
class LatencyReport:
    n: int
    nodes: int
    p50_s: float
    p95_s: float
    p99_s: float
    mean_s: float

    def summary(self) -> str:
        return (f"latency ({self.n} runs, {self.nodes}-node graph): "
                f"p50={self.p50_s*1e3:.2f}ms  p95={self.p95_s*1e3:.2f}ms  "
                f"p99={self.p99_s*1e3:.2f}ms  mean={self.mean_s*1e3:.2f}ms")


def _graph(n: int) -> Graph:
    nodes = [Node(id=f"n{i}", type=NodeType.LLM_STEP, config={"model": "mock:test"})
             for i in range(n)]
    edges = [Edge.model_validate({"from": f"n{i}", "to": f"n{i+1}"}) for i in range(n - 1)]
    return Graph(graph_id="lat", nodes=nodes, edges=edges)


async def measure(*, iters: int = 300, warmup: int = 30, nodes: int = 8) -> LatencyReport:
    graph = _graph(nodes)
    runner = await Runner.open(in_memory=True, model=MockModelPort())
    try:
        for i in range(warmup):
            await runner.run(graph, run_id=f"warm{i}")
        samples: list[float] = []
        for i in range(iters):
            t0 = time.perf_counter()
            await runner.run(graph, run_id=f"run{i}")
            samples.append(time.perf_counter() - t0)
    finally:
        await runner.close()
    samples.sort()
    return LatencyReport(
        n=iters, nodes=nodes,
        p50_s=percentile(samples, 50),
        p95_s=percentile(samples, 95),
        p99_s=percentile(samples, 99),
        mean_s=mean(samples),
    )


async def main() -> int:
    report = await measure()
    print(report.summary() + f"  (p99 ceiling {P99_CEILING_S*1e3:.0f}ms)")
    if report.p99_s > P99_CEILING_S:
        print("  FAIL: p99 latency exceeds the regression ceiling")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
