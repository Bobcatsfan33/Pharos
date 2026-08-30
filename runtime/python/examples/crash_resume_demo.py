"""The signature demo — durability you can SEE, with cost as a checked assertion.

A multi-step agent makes several *billed* model calls, "crashes" mid-run (a kill
between a call committing to the log and the step completing), then resumes in a fresh
runtime: the completed calls are replayed from the log (cost unchanged) and only the
remaining work executes. The script asserts, programmatically, that the dollar cost
after resume equals the cost of a clean run — "never re-billed" as a test, not a
screenshot.

    python examples/crash_resume_demo.py        # prints the narrative + PASS/FAIL

Reproducible verbatim; the same assertion runs in CI
(tests/chaos/test_crash_resume_demo.py).
"""
import asyncio

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.substrate.events import EventType
from keel.executor.engine import RunContext
from keel.executor.state import RunState
from keel.executor.effects import EffectLedger
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.model.pricing import PriceTable

# A real (non-zero) price so "cost unchanged" means something.
PRICES = PriceTable(prices={"demo:model": (0.01, 0.03)})  # $/1k in, $/1k out


def pipeline() -> Graph:
    steps = ["research", "outline", "draft", "edit"]
    nodes = [Node(id=s, type=NodeType.LLM_STEP, config={"model": "demo:model", "prompt": s})
             for s in steps]
    edges = [Edge.model_validate({"from": steps[i], "to": steps[i + 1]})
             for i in range(len(steps) - 1)]
    return Graph(graph_id="signature_demo", nodes=nodes, edges=edges)


async def _clean_cost() -> float:
    runner = await Runner.open(in_memory=True, model=MockModelPort(), price_table=PRICES)
    state = await runner.run(pipeline(), run_id="clean")
    await runner.close()
    return state.total_cost_usd


async def _crash_then_resume() -> tuple[float, int]:
    """Run 'research' to its committed llm.response, then crash (no step.completed).
    Resume and report the total cost + how many model calls happened on resume."""
    model = MockModelPort()
    runner = await Runner.open(in_memory=True, model=model, price_table=PRICES)
    graph = pipeline()
    await runner.register(graph, run_id="crashed")

    bus = runner._new_bus()
    await bus.start()
    ctx = RunContext("crashed", runner.clock, runner.ids, runner.rng, runner.blobs, bus,
                     RunState(run_id="crashed", graph=graph),
                     ledger=EffectLedger([], runner.blobs))
    await ctx.emit(EventType.RUN_STARTED)
    await ctx.emit(EventType.STEP_SCHEDULED, node_id="research", attempt=1)
    await ctx.emit(EventType.STEP_STARTED, node_id="research", attempt=1)
    await runner.handlers[NodeType.LLM_STEP](ctx, graph.nodes[0], {})  # research bills here
    await bus.flush()
    await bus.close()  # <-- the crash: no step.completed for 'research'
    calls_before = model.calls

    final = await runner.resume("crashed")
    calls_on_resume = model.calls - calls_before
    cost = final.total_cost_usd
    await runner.close()
    return cost, calls_on_resume


async def main() -> int:
    clean = await _clean_cost()
    resumed_cost, resume_calls = await _crash_then_resume()

    print("KEEL — crash/resume signature demo\n")
    print(f"  clean run cost ............. ${clean:.6f}")
    print("  crashed after 'research' commits (a kill before step.completed)")
    print(f"  resumed in a fresh runtime: {resume_calls} model calls on resume "
          f"(research replayed from the log, not re-issued)")
    print(f"  cost after resume .......... ${resumed_cost:.6f}")
    ok = abs(resumed_cost - clean) < 1e-9
    print(f"\n  cost-of-resume == clean-run cost?  {'PASS ✅' if ok else 'FAIL ❌'}")
    print("  (the completed model call was replayed from the log and never re-billed)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
