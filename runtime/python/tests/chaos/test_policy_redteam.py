"""P4-5 red-team: 20 scripted policy violations -> 20 blocks + 20 policy.violation
audit events, 0 prompt-only mitigations. Enforcement is at the L3 boundary the
gateway must cross to act, so there is no 'model ignored the instruction' path."""
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
from keel.services.tools.contract import ToolContract, RegisteredTool, ToolDenied
from keel.services.tools.gateway import ToolGateway
from keel.services.policy import (PolicyEngine, RBAC, RolePolicy, ArgSuffixAllowlist)


class Args(BaseModel):
    to: str = ""
    query: str = ""


class Out(BaseModel):
    ok: bool = True


@pytest.fixture(autouse=True)
def _schemas():
    clear()
    register_schema(Args)
    register_schema(Out)
    yield
    clear()


def _tool(name: str) -> RegisteredTool:
    c = ToolContract(name=name, input_schema="ref:schemas/Args", output_schema="ref:schemas/Out")

    async def impl(args):
        return {"ok": True}

    return RegisteredTool(contract=c, impl=impl)


def _engine() -> PolicyEngine:
    roles = {
        "analyst": RolePolicy(allowed_tools=frozenset({"search"}), deny_tools=frozenset({"delete"})),
        "mailer": RolePolicy(allowed_tools=frozenset({"send_email"})),
    }
    principals = {f"analyst{i}": "analyst" for i in range(10)}
    principals.update({f"mailer{i}": "mailer" for i in range(10)})
    return PolicyEngine(rules=[
        RBAC(roles, principals),
        ArgSuffixAllowlist("send_email", "to", ["@company.com"]),
    ])


async def _gateway_ctx():
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    g = Graph(graph_id="g", nodes=[Node(id="n", type=NodeType.LLM_STEP)], edges=[])
    ctx = RunContext("r", SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id="r", graph=g))
    gw = ToolGateway({"search": _tool("search"), "send_email": _tool("send_email"),
                      "delete": _tool("delete")}, policy=_engine())
    return gw, ctx, store, bus


@pytest.mark.asyncio
async def test_twenty_violations_twenty_blocks_twenty_events():
    gw, ctx, store, bus = await _gateway_ctx()
    # 20 scripted violations: analysts calling tools they lack / a denied tool, and
    # mailers sending to external domains.
    attempts = []
    for i in range(10):
        attempts.append((f"analyst{i}", "send_email", {"to": "x@company.com"}))  # not allowed
    for i in range(8):
        attempts.append((f"mailer{i}", "send_email", {"to": f"user{i}@evil.com"}))  # external
    attempts.append(("analyst0", "delete", {"query": "all"}))                       # denied tool
    attempts.append(("ghost", "search", {"query": "x"}))                            # no role

    blocks = 0
    for principal, tool, args in attempts:
        with pytest.raises(ToolDenied):
            await gw.invoke(ctx, principal, tool, args)
        blocks += 1

    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run("r")]
    violations = [e for e in events if e.type == EventType.POLICY_VIOLATION]
    assert blocks == 20
    assert len(violations) == 20
    # no tool actually executed -> no successful tool.response
    assert not [e for e in events if e.type == EventType.TOOL_RESPONSE]


@pytest.mark.asyncio
async def test_allowed_calls_pass():
    gw, ctx, store, bus = await _gateway_ctx()
    await gw.invoke(ctx, "analyst3", "search", {"query": "ok"})        # allowed tool
    await gw.invoke(ctx, "mailer2", "send_email", {"to": "a@company.com"})  # allowed domain
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run("r")]
    assert len([e for e in events if e.type == EventType.TOOL_RESPONSE]) == 2
    assert not [e for e in events if e.type == EventType.POLICY_VIOLATION]
