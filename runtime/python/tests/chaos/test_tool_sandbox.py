"""P4-3 red-team: a tool that reaches outside its declared resource access is blocked
by the out-of-process sandbox and emits tool.denied; malformed output never reaches
an agent (the output-validation barrier)."""
import pytest
from pydantic import BaseModel

from keel.kir.schema import Graph, Node, NodeType
from keel.kir.schemas_registry import register_schema, clear
from keel.substrate.ports import SystemClock, UlidIdGen, SeededRng, MemoryBlobStore
from keel.substrate.store.memory import MemoryEventStore
from keel.substrate.tracebus import TraceBus
from keel.substrate.events import EventType
from keel.executor.engine import RunContext
from keel.executor.state import RunState
from keel.services.tools.contract import ToolContract, RegisteredTool, ToolDenied, SideEffect
from keel.services.tools.gateway import ToolGateway
from keel.services.tools.sandbox import SubprocessSandbox


class Q(BaseModel):
    query: str = ""


class Hits(BaseModel):
    n: int


@pytest.fixture(autouse=True)
def _schemas():
    clear()
    register_schema(Q)
    register_schema(Hits)
    yield
    clear()


def _tool(name: str, fn: str, **kw) -> RegisteredTool:
    c = ToolContract(name=name, input_schema="ref:schemas/Q", output_schema="ref:schemas/Hits",
                     module=f"keel.services.tools._example_tools:{fn}",
                     side_effect=SideEffect.READ, **kw)

    async def _noimpl(args):  # never called for sandboxed tools
        raise AssertionError("sandboxed tool should not run in-process")

    return RegisteredTool(contract=c, impl=_noimpl)


async def _ctx():
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    g = Graph(graph_id="g", nodes=[Node(id="n", type=NodeType.LLM_STEP)], edges=[])
    ctx = RunContext("r", SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id="r", graph=g))
    return ctx, store, bus, blobs


def _gateway(tool: RegisteredTool) -> ToolGateway:
    return ToolGateway({tool.contract.name: tool}, sandbox=SubprocessSandbox())


async def _denied_reason(store, bus) -> str | None:
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run("r")]
    denied = [e for e in events if e.type == EventType.TOOL_DENIED]
    return denied[0].data.get("reason") if denied else None


@pytest.mark.asyncio
async def test_good_tool_runs_in_sandbox():
    ctx, store, bus, blobs = await _ctx()
    gw = _gateway(_tool("ok", "echo_len"))
    out = await gw.invoke(ctx, "system", "ok", {"query": "hello"})
    assert b'"n":5' in out.replace(b" ", b"")
    await bus.flush()
    await bus.close()


@pytest.mark.asyncio
async def test_network_escape_blocked():
    ctx, store, bus, blobs = await _ctx()
    gw = _gateway(_tool("net", "try_network"))  # no allow_network declared
    with pytest.raises(ToolDenied):
        await gw.invoke(ctx, "system", "net", {"query": "x"})
    assert (await _denied_reason(store, bus)) == "sandbox_violation"


@pytest.mark.asyncio
async def test_filesystem_escape_blocked():
    ctx, store, bus, blobs = await _ctx()
    gw = _gateway(_tool("fs", "try_fs"))  # no allow_fs_read declared
    with pytest.raises(ToolDenied):
        await gw.invoke(ctx, "system", "fs", {"query": "x"})
    assert (await _denied_reason(store, bus)) == "sandbox_violation"


@pytest.mark.asyncio
async def test_malformed_output_never_reaches_agent():
    ctx, store, bus, blobs = await _ctx()
    gw = _gateway(_tool("bad", "bad_output"))
    with pytest.raises(ToolDenied):
        await gw.invoke(ctx, "system", "bad", {"query": "x"})
    assert (await _denied_reason(store, bus)) == "invalid_output"
