"""Multi-worker soak (M6) — prove durability holds under sustained concurrency and
worker death.

Each batch builds a pool of runs and drains them through a leased worker pool. A
fraction of the runs are *crashed* before the pool ever sees them — driven partway and
abandoned mid-flight — which is the faithful model of ``kill -9``: the run is left as a
partial, durable event log. Two crash shapes are injected deterministically:

  * **committed-prefix crash** — the first *k* steps committed (``STEP_COMPLETED``), then
    death. Resume replays those steps from the log; they are never re-billed.
  * **in-flight crash** — the next step was *started* but not committed when death hit.
    Resume re-runs exactly that one step (one bounded re-bill), then continues.

On top of that, every run is delivered to the scheduler more than once (at-least-once
delivery), so workers also exercise resuming an already-completed run (a no-op that
re-bills nothing) and lose lease races to each other.

The soak asserts the invariants that must hold regardless of crash timing:

  * **Liveness** — every run reaches ``completed``.
  * **Sound logs** — gap-free, duplicate-free seq; folded cost == sum of event costs.
  * **Commit-once** — every node has exactly one ``STEP_COMPLETED`` (a node may be
    *started* twice after an in-flight crash, but commits exactly once).
  * **Zero re-bill** — total model calls == committed steps (every node's model is
    called exactly once, ever). A committed step is replayed from the log on resume; an
    in-flight step whose model response was already recorded is *also* replayed, not
    re-called. A completed/recorded model call is never re-billed, across any crash.

CI runs a short bounded smoke (``test_soak.py``). The full 24h operational soak is the
same harness with a duration budget:

    KEEL_SOAK_DURATION_S=86400 KEEL_SOAK_WORKERS=16 KEEL_SOAK_RUNS=500 \
        python -m tests.chaos.soak
"""
from __future__ import annotations

import asyncio
import os
import random
import time
from dataclasses import dataclass, field

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.substrate.events import EventType
from keel.substrate.ports import SystemClock
from keel.executor.engine import RunContext
from keel.executor.state import RunState
from keel.executor.effects import EffectLedger
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.scheduler import MemoryScheduler
from keel.services.worker import LeasedRunLoop
from keel.executor.lease import MemoryLeaseManager


@dataclass
class SoakReport:
    runs_per_batch: int = 0
    nodes_per_run: int = 0
    workers: int = 0
    batches: int = 0
    crashes_prefix: int = 0
    crashes_inflight: int = 0
    rebills: int = 0
    model_calls: int = 0
    committed_steps: int = 0
    total_runs: int = 0
    wall_s: float = 0.0
    problems: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    def summary(self) -> str:
        rate = self.total_runs / self.wall_s if self.wall_s else 0.0
        return (f"soak: {self.total_runs} runs / {self.batches} batch(es), "
                f"{self.workers} workers, "
                f"{self.crashes_prefix} prefix + {self.crashes_inflight} in-flight crashes, "
                f"{self.rebills} re-bills (expect 0), {rate:.0f} runs/s, {self.wall_s:.1f}s — "
                f"{'CLEAN' if self.ok else 'PROBLEMS: ' + '; '.join(self.problems)}")


def _chain(graph_id: str, n: int) -> Graph:
    nodes = [Node(id=f"s{i}", type=NodeType.LLM_STEP, config={"model": "mock:test"})
             for i in range(n)]
    edges = [Edge.model_validate({"from": f"s{i}", "to": f"s{i+1}"}) for i in range(n - 1)]
    return Graph(graph_id=graph_id, nodes=nodes, edges=edges)


async def _crash_partial(runner: Runner, graph: Graph, run_id: str, *,
                         commit: int, leave_inflight: bool) -> None:
    """Drive a fresh run partway and abandon it, leaving a durable partial log — the
    faithful model of a worker killed mid-run. Commits ``commit`` steps; if
    ``leave_inflight`` also emits a STEP_STARTED for the next step without completing it
    (one model call that resume will have to redo)."""
    bus = runner._new_bus()
    await bus.start()
    state = RunState(run_id=run_id, graph=graph)
    ctx = RunContext(run_id, runner.clock, runner.ids, runner.rng, runner.blobs, bus,
                     state, ledger=EffectLedger([], runner.blobs))
    try:
        await ctx.emit(EventType.RUN_STARTED)
        for i in range(commit):
            node = graph.nodes[i]
            inputs = {graph.nodes[i - 1].id: b"x"} if i else {}
            await ctx.emit(EventType.STEP_SCHEDULED, node_id=node.id, attempt=1)
            await ctx.emit(EventType.STEP_STARTED, node_id=node.id, attempt=1)
            result = await runner.handlers[NodeType.LLM_STEP](ctx, node, inputs)
            await ctx.emit(EventType.STEP_COMPLETED, node_id=node.id, attempt=1,
                           payload=result)
        if leave_inflight and commit < len(graph.nodes):
            node = graph.nodes[commit]
            await ctx.emit(EventType.STEP_SCHEDULED, node_id=node.id, attempt=1)
            await ctx.emit(EventType.STEP_STARTED, node_id=node.id, attempt=1)
            # invoke the handler (a real model call) but die before committing it
            await runner.handlers[NodeType.LLM_STEP](ctx, node, {graph.nodes[commit - 1].id: b"x"})
    finally:
        await bus.flush()
        await bus.close()


async def _run_batch(runner: Runner, *, runs: int, nodes: int, workers: int,
                     crash_prob: float, rng: random.Random, report: SoakReport,
                     batch: int, deliveries: int = 2) -> None:
    scheduler = MemoryScheduler()
    leases = MemoryLeaseManager(SystemClock(), ttl_s=60)
    graphs: dict[str, Graph] = {}
    for i in range(runs):
        rid = f"b{batch}_run{i}"
        g = _chain(rid, nodes)
        graphs[rid] = g
        await runner.register(g, run_id=rid)
        if rng.random() < crash_prob:
            commit = rng.randint(1, nodes - 1)
            inflight = rng.random() < 0.5
            await _crash_partial(runner, g, rid, commit=commit, leave_inflight=inflight)
            if inflight:
                report.crashes_inflight += 1
            else:
                report.crashes_prefix += 1
        for _ in range(deliveries):
            await scheduler.enqueue(rid)

    # Drain every delivery across the pool with a shared counter, so no worker blocks
    # on an empty queue at the tail. Workers race for leases; a redundant delivery of an
    # already-completed run resumes it as a no-op (re-bills nothing).
    remaining = [runs * deliveries]

    async def worker(wid: str) -> None:
        loop = LeasedRunLoop(runner, scheduler, leases, wid, heartbeat_s=0.05)
        while remaining[0] > 0:
            remaining[0] -= 1
            await loop.serve_once()

    await asyncio.gather(*(worker(f"w{batch}_{i}") for i in range(workers)))

    # ---- invariant checks over the final, durable logs ----
    for rid, g in graphs.items():
        events = await runner.read_events(rid)
        seqs = [e.seq for e in events]
        if seqs != list(range(len(events))):
            report.problems.append(f"{rid}: seq not gap-free")
        if len(set(seqs)) != len(seqs):
            report.problems.append(f"{rid}: duplicate seq")
        state = await runner.load_state(rid)
        if state.status != "completed":
            report.problems.append(f"{rid}: status {state.status} != completed")
        if abs(state.total_cost_usd - sum(e.cost_usd for e in events)) > 1e-9:
            report.problems.append(f"{rid}: cost fold mismatch")
        per_node: dict[str, int] = {}
        for e in events:
            if e.type == EventType.STEP_COMPLETED:
                per_node[e.node_id or "-"] = per_node.get(e.node_id or "-", 0) + 1
        if len(per_node) != nodes or any(c != 1 for c in per_node.values()):
            report.problems.append(f"{rid}: commit-once violated ({per_node})")
        report.committed_steps += sum(per_node.values())


async def run_soak(*, workers: int = 4, runs: int = 12, nodes: int = 4,
                   crash_prob: float = 0.4, seed: int = 0,
                   duration_s: float | None = None, batches: int = 1) -> SoakReport:
    """Run the soak. With ``duration_s`` set, keep running batches until the time budget
    is spent (the 24h operational mode); otherwise run exactly ``batches`` batches."""
    rng = random.Random(seed)
    model = MockModelPort()
    runner = await Runner.open(in_memory=True, model=model)
    report = SoakReport(runs_per_batch=runs, nodes_per_run=nodes, workers=workers)
    t0 = time.monotonic()
    b = 0
    try:
        while True:
            await _run_batch(runner, runs=runs, nodes=nodes, workers=workers,
                             crash_prob=crash_prob, rng=rng, report=report, batch=b)
            b += 1
            if duration_s is not None:
                if time.monotonic() - t0 >= duration_s:
                    break
            elif b >= batches:
                break
    finally:
        report.batches = b
        report.total_runs = runs * b
        report.wall_s = time.monotonic() - t0
        report.model_calls = model.calls
        # A re-bill is any model call beyond one-per-committed-step. The architecture
        # records every model response before the next step, so a crash at an event
        # boundary replays it instead of re-calling: re-bills are zero.
        report.rebills = report.model_calls - report.committed_steps
        await runner.close()
    if report.rebills != 0:
        report.problems.append(
            f"re-billed: model calls {report.model_calls} != committed steps "
            f"{report.committed_steps} ({report.rebills} extra calls)")
    return report


async def main() -> int:
    report = await run_soak(
        workers=int(os.environ.get("KEEL_SOAK_WORKERS", "8")),
        runs=int(os.environ.get("KEEL_SOAK_RUNS", "50")),
        nodes=int(os.environ.get("KEEL_SOAK_NODES", "5")),
        crash_prob=float(os.environ.get("KEEL_SOAK_CRASH_PROB", "0.4")),
        seed=int(os.environ.get("KEEL_SOAK_SEED", "0")),
        duration_s=(float(os.environ["KEEL_SOAK_DURATION_S"])
                    if "KEEL_SOAK_DURATION_S" in os.environ else None),
        batches=int(os.environ.get("KEEL_SOAK_BATCHES", "1")),
    )
    print(report.summary())
    return 0 if report.ok else 1


if __name__ == "__main__":
    import sys
    sys.exit(asyncio.run(main()))
