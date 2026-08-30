"""Node-type breadth: router branching + skip, map/reduce, bounded crew region,
budget enforcement, and the typed tool gateway."""
import json
import pytest
from pydantic import BaseModel

from keel.kir.schema import Graph, Node, Edge, NodeType, Region
from keel.kir.schemas_registry import register_schema, clear
from keel.substrate.ports import SystemClock, UlidIdGen, SeededRng, MemoryBlobStore
from keel.substrate.store.memory import MemoryEventStore
from keel.substrate.tracebus import TraceBus
from keel.substrate.events import EventType
from keel.executor.engine import Executor, RunContext, StepInterceptor
from keel.executor.state import RunState
from keel.services.model.handlers import MockModelPort
from keel.services.nodes import default_handlers
from keel.services.budget import Budgeter, Budget, BudgetAction, BudgetInterceptor
from keel.services.tools.contract import ToolContract, SideEffect, RegisteredTool
from keel.services.tools.gateway import ToolGateway
from keel.services.tools.contract import ToolDenied


async def run_graph(graph, handlers, interceptors=None, rid="r"):
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    ctx = RunContext(rid, SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id=rid, graph=graph))
    final = await Executor(store, bus, blobs, handlers,
                           interceptors=interceptors).run(graph, ctx)
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run(rid)]
    return final, blobs, events


def _handlers():
    return default_handlers(model=MockModelPort(reply='{"ok": true}'))


@pytest.mark.asyncio
async def test_router_branch_skips_untaken_path():
    g = Graph(
        graph_id="g",
        nodes=[
            Node(id="r", type=NodeType.ROUTER, config={"branch": "x"}),
            Node(id="a", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
            Node(id="b", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
        ],
        edges=[
            Edge.model_validate({"from": "r", "to": "a", "when": "branch:x"}),
            Edge.model_validate({"from": "r", "to": "b", "when": "branch:y"}),
        ],
    )
    final, _, _ = await run_graph(g, _handlers())
    assert final.status == "completed"
    assert final.steps["a"].status == "completed"
    assert final.steps["b"].status == "skipped"


@pytest.mark.asyncio
async def test_map_reduce():
    g = Graph(
        graph_id="g",
        nodes=[
            Node(id="m", type=NodeType.MAP, config={"items": [1, 2, 3, 4], "over": "items"}),
            Node(id="rd", type=NodeType.REDUCE, config={"reduce": "sum"}),
        ],
        edges=[Edge.model_validate({"from": "m", "to": "rd"})],
    )
    final, blobs, _ = await run_graph(g, _handlers())
    assert final.status == "completed"
    out = json.loads(blobs.get(final.steps["rd"].result_ref))
    assert out["result"] == 10


@pytest.mark.asyncio
async def test_crew_region_runs_bounded_subrun():
    region = Region(
        max_steps=10, max_tokens=10_000, output_schema="",
        nodes=[
            Node(id="c1", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
            Node(id="c2", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
        ],
        edges=[Edge.model_validate({"from": "c1", "to": "c2"})],
    )
    g = Graph(graph_id="g",
              nodes=[Node(id="crew", type=NodeType.CREW, region=region)], edges=[])
    final, blobs, events = await run_graph(g, _handlers())
    assert final.status == "completed"
    assert final.steps["crew"].status == "completed"
    # Crew node produced the region's sink output.
    assert final.steps["crew"].result_ref is not None


@pytest.mark.asyncio
async def test_crew_region_killed_by_step_budget():
    region = Region(
        max_steps=1, max_tokens=10_000, output_schema="",
        nodes=[
            Node(id="c1", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
            Node(id="c2", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
        ],
        edges=[Edge.model_validate({"from": "c1", "to": "c2"})],
    )
    g = Graph(graph_id="g",
              nodes=[Node(id="crew", type=NodeType.CREW, region=region)], edges=[])
    final, _, _ = await run_graph(g, _handlers())
    assert final.status == "failed"  # region exceeded max_steps -> KILL -> crew fails


@pytest.mark.asyncio
async def test_budget_kill_halts_run():
    g = Graph(
        graph_id="g",
        nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
               Node(id="b", type=NodeType.LLM_STEP, config={"model": "mock:test"})],
        edges=[Edge.model_validate({"from": "a", "to": "b"})],
    )
    budgeter = Budgeter(SystemClock())
    budgeter.register("run:r", Budget(max_steps=1, action=BudgetAction.KILL))
    final, _, events = await run_graph(g, _handlers(), interceptors=[BudgetInterceptor(budgeter)])
    assert final.status == "failed"
    assert any(e.type == EventType.BUDGET_EXCEEDED for e in events)
    assert final.steps.get("b", None) is None or final.steps["b"].status != "completed"


@pytest.mark.asyncio
async def test_budget_pause_then_resume():
    g = Graph(
        graph_id="g",
        nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
               Node(id="b", type=NodeType.LLM_STEP, config={"model": "mock:test"})],
        edges=[Edge.model_validate({"from": "a", "to": "b"})],
    )
    budgeter = Budgeter(SystemClock())
    budgeter.register("run:r", Budget(max_steps=1, action=BudgetAction.PAUSE))
    final, _, events = await run_graph(g, _handlers(), interceptors=[BudgetInterceptor(budgeter)])
    assert final.status == "paused"
    assert any(e.type == EventType.RUN_PAUSED for e in events)
    assert "b" not in final.steps  # paused before b was ever scheduled


# --------------------------------------------------------------------------- #
# Tool gateway
# --------------------------------------------------------------------------- #
class Q(BaseModel):
    query: str


class Hits(BaseModel):
    n: int


@pytest.fixture(autouse=True)
def _schemas():
    clear()
    register_schema(Q)
    register_schema(Hits)
    yield
    clear()


def _gateway(allowed_agents=None):
    contract = ToolContract(name="search", input_schema="ref:schemas/Q",
                            output_schema="ref:schemas/Hits", side_effect=SideEffect.READ,
                            allowed_agents=allowed_agents or [])

    async def impl(args):
        return {"n": len(args["query"])}

    return ToolGateway({"search": RegisteredTool(contract=contract, impl=impl)})


@pytest.mark.asyncio
async def test_tool_step_typed_success():
    g = Graph(graph_id="g",
              nodes=[Node(id="t", type=NodeType.TOOL_STEP, tool="search",
                          config={"args": {"query": "hello"}})], edges=[])
    handlers = default_handlers(model=MockModelPort(), gateway=_gateway())
    final, blobs, events = await run_graph(g, handlers)
    assert final.status == "completed"
    assert json.loads(blobs.get(final.steps["t"].result_ref))["n"] == 5
    assert any(e.type == EventType.TOOL_REQUEST for e in events)
    assert any(e.type == EventType.TOOL_RESPONSE for e in events)


@pytest.mark.asyncio
async def test_tool_invalid_input_denied_and_evented():
    gw = _gateway()
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    g = Graph(graph_id="g", nodes=[Node(id="t", type=NodeType.TOOL_STEP, tool="search")],
              edges=[])
    ctx = RunContext("r", SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id="r", graph=g))
    with pytest.raises(ToolDenied):
        await gw.invoke(ctx, "system", "search", {"wrong": "field"})
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run("r")]
    denied = [e for e in events if e.type == EventType.TOOL_DENIED]
    assert denied and denied[0].data["reason"] == "invalid_input"


@pytest.mark.asyncio
async def test_tool_agent_not_allowed():
    gw = _gateway(allowed_agents=["trusted"])
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    g = Graph(graph_id="g", nodes=[Node(id="t", type=NodeType.TOOL_STEP, tool="search")],
              edges=[])
    ctx = RunContext("r", SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id="r", graph=g))
    with pytest.raises(ToolDenied):
        await gw.invoke(ctx, "evil", "search", {"query": "x"})
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run("r")]
    assert any(e.data.get("reason") == "agent_not_allowed"
               for e in events if e.type == EventType.TOOL_DENIED)


def test_step_interceptor_is_protocol():
    assert isinstance(BudgetInterceptor(Budgeter(SystemClock())), StepInterceptor)
