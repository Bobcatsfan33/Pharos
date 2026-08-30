"""Seed a durable store with sample runs for the read-only trace viewer (M3).

Pre-loads the crash/resume signature run plus two other sample runs into a SQLite
store + blob dir, so `keel view` (or a hosted read-only deployment) shows real
timelines — prompts, tokens, dollars, the resume seam, and the replay diff — without
anyone installing or running anything first.

    python -m scripts.seed_sample_runs --db sample.db --blobs sample-blobs
    keel view --db sample.db --blobs sample-blobs
"""
import argparse
import asyncio

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.substrate.events import EventType
from keel.executor.engine import RunContext
from keel.executor.state import RunState
from keel.executor.effects import EffectLedger
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.model.pricing import PriceTable

PRICES = PriceTable(prices={"demo:model": (0.01, 0.03)})


def _pipeline(gid: str, steps: list[str]) -> Graph:
    nodes = [Node(id=s, type=NodeType.LLM_STEP, config={"model": "demo:model", "prompt": s})
             for s in steps]
    edges = [Edge.model_validate({"from": steps[i], "to": steps[i + 1]})
             for i in range(len(steps) - 1)]
    return Graph(graph_id=gid, nodes=nodes, edges=edges)


async def _seed_crash_resume(runner: Runner) -> None:
    graph = _pipeline("signature_demo", ["research", "outline", "draft", "edit"])
    await runner.register(graph, run_id="crash-resume")
    bus = runner._new_bus()
    await bus.start()
    ctx = RunContext("crash-resume", runner.clock, runner.ids, runner.rng, runner.blobs,
                     bus, RunState(run_id="crash-resume", graph=graph),
                     ledger=EffectLedger([], runner.blobs))
    await ctx.emit(EventType.RUN_STARTED)
    await ctx.emit(EventType.STEP_SCHEDULED, node_id="research", attempt=1)
    await ctx.emit(EventType.STEP_STARTED, node_id="research", attempt=1)
    await runner.handlers[NodeType.LLM_STEP](ctx, graph.nodes[0], {})
    await bus.flush()
    await bus.close()              # the crash
    await runner.resume("crash-resume")  # the resume (shows the run.resumed seam)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="sample.db")
    ap.add_argument("--blobs", default="sample-blobs")
    args = ap.parse_args()

    runner = await Runner.open(db_path=args.db, blob_dir=args.blobs,
                               model=MockModelPort(), price_table=PRICES)
    await _seed_crash_resume(runner)
    await runner.run(_pipeline("research_pipeline", ["research", "write"]), run_id="clean")
    await runner.run(_pipeline("long_chain", [f"s{i}" for i in range(6)]), run_id="chain")
    await runner.close()
    print(f"seeded crash-resume, clean, chain -> {args.db} (view with: "
          f"keel view --db {args.db} --blobs {args.blobs})")


if __name__ == "__main__":
    asyncio.run(main())
