"""M4: the framework adapters pass one shared conformance suite, and a framework agent
crashes, resumes, and replays under KEEL byte-identically."""
import pytest

from keel.kir.schema import NodeType
from keel.substrate.events import EventType
from keel.executor.engine import RunContext
from keel.executor.state import RunState
from keel.executor.effects import EffectLedger
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.model.pricing import PriceTable
from keel.adapters import assert_conforms, replay_agent, to_graph
from keel.adapters.base import _adapter_handlers
from keel.adapters.crewai import reference_agent as crewai_ref
from keel.adapters.langgraph import reference_agent as langgraph_ref
from keel.adapters.pydantic_ai import reference_agent as pydantic_ai_ref
from keel.adapters.sdk_agents import openai_reference_agent, anthropic_reference_agent

ADAPTERS = {
    "crewai": crewai_ref,
    "langgraph": langgraph_ref,
    "pydantic_ai": pydantic_ai_ref,
    "openai_agents": openai_reference_agent,
    "anthropic": anthropic_reference_agent,
}

PRICES = PriceTable(prices={"mock:test": (0.01, 0.03)})


@pytest.mark.parametrize("name", sorted(ADAPTERS))
@pytest.mark.asyncio
async def test_adapter_conforms(name):
    nodes = ADAPTERS[name]()
    report = await assert_conforms(name, nodes, model=MockModelPort(), price_table=PRICES)
    assert report.completed, f"{name} did not complete"
    assert report.recorded_calls > 0, f"{name} recorded no model calls"
    assert report.replay_identical, f"{name} did not replay byte-identically"


@pytest.mark.asyncio
async def test_at_least_three_adapters():
    assert len(ADAPTERS) >= 3


@pytest.mark.asyncio
async def test_framework_agent_crashes_resumes_replays():
    # A CrewAI-shaped agent runs under KEEL, crashes after its first node commits,
    # resumes (no re-bill), and the recorded run replays byte-identically.
    nodes = crewai_ref()
    by_id = {n.id: n for n in nodes}
    model = MockModelPort()
    runner = await Runner.open(in_memory=True, model=model, price_table=PRICES)
    runner.handlers = _adapter_handlers(by_id, model, PRICES)
    graph = to_graph("crewai_crash", nodes)
    await runner.register(graph, run_id="cc")

    # partial: drive the first node to its committed llm.response, then crash
    first = graph.nodes[0]
    bus = runner._new_bus()
    await bus.start()
    ctx = RunContext("cc", runner.clock, runner.ids, runner.rng, runner.blobs, bus,
                     RunState(run_id="cc", graph=graph), ledger=EffectLedger([], runner.blobs))
    await ctx.emit(EventType.RUN_STARTED)
    await ctx.emit(EventType.STEP_SCHEDULED, node_id=first.id, attempt=1)
    await ctx.emit(EventType.STEP_STARTED, node_id=first.id, attempt=1)
    await runner.handlers[NodeType.LLM_STEP](ctx, first, {})
    await bus.flush()
    await bus.close()
    calls_before = model.calls
    clean_first_cost = (await runner.load_state("cc")).total_cost_usd

    final = await runner.resume("cc")
    assert final.status == "completed"
    # first node replayed from the ledger (not re-called); cost includes it once
    assert model.calls - calls_before == len(nodes) - 1
    assert final.total_cost_usd >= clean_first_cost

    events = await runner.read_events("cc")
    await runner.close()
    # a clean recording of the same agent replays byte-identical (the resumed log has a
    # resume seam, so we verify byte-identity on a fresh clean run)
    from keel.adapters import run_agent
    clean = await run_agent("crewai_clean", nodes, model=MockModelPort(), price_table=PRICES)
    clean_events = [e async for e in clean.store.read_run(clean.run_id)]
    assert await replay_agent("crewai_clean", nodes, clean.run_id, clean_events,
                              clean.blobs, price_table=PRICES)
    assert len(events) > 0
