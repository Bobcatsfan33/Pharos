"""P3-1: there is no spend path that bypasses the budgeter. Spend is metered at
RunContext.emit (the chokepoint), so retries and crew-region spend are all counted,
and a breach halts within one step boundary.
"""
import pytest

from keel.kir.schema import Graph, Node, Edge, NodeType, Region
from keel.substrate.ports import SystemClock, UlidIdGen, SeededRng, MemoryBlobStore
from keel.substrate.store.memory import MemoryEventStore
from keel.substrate.tracebus import TraceBus
from keel.substrate.events import EventType, TokenUsage
from keel.executor.engine import Executor, RunContext, RetryableError
from keel.executor.state import RunState
from keel.services.budget import Budgeter, Budget, BudgetAction, BudgetInterceptor
from keel.services.model.handlers import MockModelPort
from keel.services.nodes import default_handlers


async def _run(graph, handlers, budgeter, scope="run:r"):
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    ctx = RunContext("r", SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id="r", graph=graph), scope=scope, budgeter=budgeter)
    final = await Executor(store, bus, blobs, handlers,
                           [BudgetInterceptor(budgeter)]).run(graph, ctx)
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run("r")]
    return final, events, store


@pytest.mark.asyncio
async def test_retry_attempts_all_counted():
    # A handler that bills on every attempt and fails the first one (retryable).
    attempts = {"n": 0}

    async def flaky(ctx, node, inputs):
        attempts["n"] += 1
        await ctx.emit(EventType.LLM_RESPONSE, node_id=node.id, payload=b"x",
                       tokens=TokenUsage(input=10, output=5), cost_usd=0.01)
        if attempts["n"] == 1:
            raise RetryableError("try again", "transient")
        return b"ok"

    g = Graph(graph_id="g",
              nodes=[Node(id="a", type=NodeType.LLM_STEP,
                          retry={"max": 2, "backoff": "none"})], edges=[])
    budgeter = Budgeter(SystemClock())
    budgeter.register("run:r", Budget(max_usd=None, action=BudgetAction.WARN))
    final, events, store = await _run(g, {NodeType.LLM_STEP: flaky}, budgeter)

    assert final.status == "completed"
    assert attempts["n"] == 2
    # BOTH attempts' spend was metered — the failed attempt did not bypass the budget.
    meter = budgeter.meter("run:r")
    assert meter is not None and abs(meter.usd - 0.02) < 1e-9
    assert abs(final.total_cost_usd - 0.02) < 1e-9


@pytest.mark.asyncio
async def test_crew_internal_steps_count_against_run_budget():
    # A 5-step region under a run that only allows 3 steps -> the region cannot run
    # all 5; crew-internal spend is visible to (and halted by) the run budget.
    region = Region(
        max_steps=99, max_tokens=10 ** 9, output_schema="",
        nodes=[Node(id=f"c{i}", type=NodeType.LLM_STEP, config={"model": "mock:test"})
               for i in range(5)],
        edges=[Edge.model_validate({"from": f"c{i}", "to": f"c{i+1}"}) for i in range(4)],
    )
    g = Graph(graph_id="g",
              nodes=[Node(id="crew", type=NodeType.CREW, region=region)], edges=[])
    budgeter = Budgeter(SystemClock())
    budgeter.register("run:r", Budget(max_steps=3, action=BudgetAction.KILL))
    handlers = default_handlers(model=MockModelPort())
    final, events, store = await _run(g, handlers, budgeter)

    child = [e async for e in store.read_run("r::crew")]
    completed = [e for e in child if e.type == EventType.STEP_COMPLETED]
    assert final.status == "failed"                       # run budget halted the crew
    # Only 3 of the region's 5 steps ran — crew-internal spend did NOT bypass the
    # run-level step budget.
    assert len(completed) == 3, f"crew ran {len(completed)} steps, run budget was 3"
    assert any(e.type == EventType.BUDGET_EXCEEDED for e in child)


@pytest.mark.asyncio
async def test_committed_spend_equals_event_costs():
    g = Graph(
        graph_id="g",
        nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "anthropic:claude-haiku-4-5"}),
               Node(id="b", type=NodeType.LLM_STEP, config={"model": "anthropic:claude-haiku-4-5"})],
        edges=[Edge.model_validate({"from": "a", "to": "b"})],
    )
    budgeter = Budgeter(SystemClock())
    budgeter.register("run:r", Budget(max_usd=None, action=BudgetAction.WARN))
    handlers = default_handlers(model=MockModelPort())
    final, events, store = await _run(g, handlers, budgeter)

    meter = budgeter.meter("run:r")
    assert meter is not None
    assert abs(meter.usd - sum(e.cost_usd for e in events)) < 1e-9  # chokepoint == log
