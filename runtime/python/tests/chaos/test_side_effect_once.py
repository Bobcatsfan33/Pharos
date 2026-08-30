"""M1: side-effect-once across crash and resume. A model/tool call that committed to
the log before the step completed is replayed from the effect ledger on resume — not
re-issued, not re-billed. Verified with an effect counter."""
import pytest
from pydantic import BaseModel

from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.kir.schemas_registry import register_schema, clear
from keel.substrate.events import EventType
from keel.executor.engine import RunContext
from keel.executor.state import RunState
from keel.executor.effects import EffectLedger
from keel.services.runner import Runner
from keel.services.model.handlers import MockModelPort
from keel.services.nodes import default_handlers
from keel.services.tools.contract import ToolContract, RegisteredTool, SideEffect
from keel.services.tools.gateway import ToolGateway


def _chain() -> Graph:
    return Graph(graph_id="g",
                 nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "mock:test"}),
                        Node(id="b", type=NodeType.LLM_STEP, config={"model": "mock:test"})],
                 edges=[Edge.model_validate({"from": "a", "to": "b"})])


async def _crash_after_node_a(runner: Runner, graph: Graph, run_id: str) -> None:
    """Drive node 'a' through its real handler to llm.response, then stop without
    emitting step.completed — exactly a crash between commit and step completion."""
    await runner.register(graph, run_id=run_id)
    bus = runner._new_bus()
    await bus.start()
    state = RunState(run_id=run_id, graph=graph)
    ctx = RunContext(run_id, runner.clock, runner.ids, runner.rng, runner.blobs, bus,
                     state, ledger=EffectLedger([], runner.blobs))
    node_a = graph.nodes[0]
    await ctx.emit(EventType.RUN_STARTED)
    await ctx.emit(EventType.STEP_SCHEDULED, node_id="a", attempt=1)
    await ctx.emit(EventType.STEP_STARTED, node_id="a", attempt=1)
    await runner.handlers[NodeType.LLM_STEP](ctx, node_a, {})  # emits llm.request+response
    # CRASH: no step.completed
    await bus.flush()
    await bus.close()


@pytest.mark.asyncio
async def test_model_call_not_rebilled_on_resume():
    model = MockModelPort()
    runner = await Runner.open(in_memory=True, model=model)
    graph = _chain()
    await _crash_after_node_a(runner, graph, "r")
    assert model.calls == 1  # node 'a' made one model call before the crash

    final = await runner.resume("r")
    await runner.close()
    assert final.status == "completed"
    # 'a' was replayed from the ledger (no re-call); only 'b' ran live.
    assert model.calls == 2, f"node 'a' was re-billed on resume (calls={model.calls})"
    # exactly one llm.response per node in the final log (no duplicate for 'a')
    events = [e async for e in runner.store.read_run("r")]
    resp_a = [e for e in events if e.type == EventType.LLM_RESPONSE and e.node_id == "a"]
    assert len(resp_a) == 1


class Args(BaseModel):
    n: int = 0


class Out(BaseModel):
    seen: int


@pytest.fixture()
def _schemas():
    clear()
    register_schema(Args)
    register_schema(Out)
    yield
    clear()


@pytest.mark.asyncio
async def test_tool_effect_executed_exactly_once(_schemas):
    calls = {"n": 0}

    async def impl(args):
        calls["n"] += 1  # the side effect
        return {"seen": calls["n"]}

    contract = ToolContract(name="effect", input_schema="ref:schemas/Args",
                            output_schema="ref:schemas/Out", side_effect=SideEffect.WRITE,
                            idempotent=False)
    gateway = ToolGateway({"effect": RegisteredTool(contract=contract, impl=impl)})
    runner = await Runner.open(in_memory=True, model=MockModelPort(), gateway=gateway)
    runner.handlers = default_handlers(model=MockModelPort(), gateway=gateway)
    graph = Graph(graph_id="t",
                  nodes=[Node(id="t1", type=NodeType.TOOL_STEP, tool="effect",
                              config={"args": {"n": 1}})], edges=[])

    # partial: run the tool to tool.response, then crash before step.completed
    await runner.register(graph, run_id="tr")
    bus = runner._new_bus()
    await bus.start()
    state = RunState(run_id="tr", graph=graph)
    ctx = RunContext("tr", runner.clock, runner.ids, runner.rng, runner.blobs, bus,
                     state, ledger=EffectLedger([], runner.blobs))
    await ctx.emit(EventType.RUN_STARTED)
    await ctx.emit(EventType.STEP_SCHEDULED, node_id="t1", attempt=1)
    await ctx.emit(EventType.STEP_STARTED, node_id="t1", attempt=1)
    await runner.handlers[NodeType.TOOL_STEP](ctx, graph.nodes[0], {})  # the effect fires
    await bus.flush()
    await bus.close()
    assert calls["n"] == 1

    final = await runner.resume("tr")
    await runner.close()
    assert final.status == "completed"
    # the side effect did NOT fire again — replayed from the ledger.
    assert calls["n"] == 1, f"tool effect re-executed on resume (n={calls['n']})"
