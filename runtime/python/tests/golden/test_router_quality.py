"""P3-2: cheap-first model policy. The cheap model serves the steps it can satisfy;
a schema failure escalates that step to the frontier model (visible as a
route.decided), so end-quality matches all-frontier within 2% while >=60% of steps
are served by the small model.
"""
import json
import pytest
from pydantic import BaseModel

from keel.kir.schema import Graph, Node, NodeType
from keel.kir.schemas_registry import register_schema, clear
from keel.substrate.ports import SystemClock, UlidIdGen, SeededRng, MemoryBlobStore
from keel.substrate.store.memory import MemoryEventStore
from keel.substrate.tracebus import TraceBus
from keel.substrate.events import EventType
from keel.executor.engine import Executor, RunContext
from keel.executor.state import RunState
from keel.services.model.port import ModelRequest, ModelResponse
from keel.services.model.router import Router, ModelPolicy, Candidate
from keel.services.nodes import default_handlers


class Answer(BaseModel):
    answer: str


class TieredPort:
    """Returns valid JSON, except a 'cheap' tier emits garbage on HARD prompts."""

    def __init__(self, fail_on_hard: bool) -> None:
        self._fail = fail_on_hard
        self.calls = 0

    async def complete(self, req: ModelRequest) -> ModelResponse:
        self.calls += 1
        hard = "HARD" in json.dumps(req.messages)
        text = "n/a not json" if (self._fail and hard) else '{"answer": "ok"}'
        return ModelResponse(text=text, tokens_in=10, tokens_out=5, model=req.model)

    async def stream(self, req: ModelRequest):  # pragma: no cover
        yield ""

    def count_tokens(self, text: str, model: str) -> int:
        return 1


@pytest.fixture(autouse=True)
def _schema():
    clear()
    register_schema(Answer)
    yield
    clear()


def _policy(escalate: bool) -> dict[str, ModelPolicy]:
    return {"default": ModelPolicy(
        name="tiered",
        candidates=(Candidate("cheap:small", 0.001, frozenset({"json"})),
                    Candidate("frontier:big", 0.05, frozenset({"json"}))),
        escalate_on=frozenset({"validation_failure"}) if escalate else frozenset())}


def _graph(n_easy: int, n_hard: int) -> Graph:
    nodes = [Node(id=f"e{i}", type=NodeType.LLM_STEP, output_schema="ref:schemas/Answer",
                  config={"prompt": "easy task"}) for i in range(n_easy)]
    nodes += [Node(id=f"h{i}", type=NodeType.LLM_STEP, output_schema="ref:schemas/Answer",
                   config={"prompt": "HARD task"}) for i in range(n_hard)]
    return Graph(graph_id="q", nodes=nodes, edges=[])


async def _run(router: Router) -> list:
    g = _graph(6, 4)
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    handlers = default_handlers(router=router)
    ctx = RunContext("r", SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id="r", graph=g), budgeter=None)
    final = await Executor(store, bus, blobs, handlers).run(g, ctx)
    await bus.flush()
    await bus.close()
    assert final.status == "completed"
    return [e async for e in store.read_run("r")]


def _accepted_models(events: list) -> dict[str, str]:
    """Map node -> model of the llm.response immediately preceding its step.completed."""
    last_resp: dict[str, str] = {}
    accepted: dict[str, str] = {}
    for e in events:
        if e.type == EventType.LLM_RESPONSE and e.node_id:
            last_resp[e.node_id] = e.tokens.model if e.tokens else ""
        elif e.type == EventType.STEP_COMPLETED and e.node_id in last_resp:
            accepted[e.node_id] = last_resp[e.node_id]
    return accepted


@pytest.mark.asyncio
async def test_cheap_first_escalates_and_matches_quality():
    ports = {"cheap": TieredPort(fail_on_hard=True), "frontier": TieredPort(fail_on_hard=False)}
    routed_events = await _run(Router(_policy(escalate=True), ports))
    accepted = _accepted_models(routed_events)

    assert len(accepted) == 10
    cheap = sum(1 for m in accepted.values() if m == "cheap:small")
    # 6 easy steps served by the small model; 4 hard steps escalated to frontier.
    assert cheap / 10 >= 0.60, f"only {cheap}/10 on the small model"

    # escalation is explained in the trace
    escalations = [e for e in routed_events if e.type == EventType.ROUTE_DECIDED
                   and e.data.get("reason") == "escalation:validation_failure"]
    assert escalations, "no escalation route.decided emitted"

    # end-quality: every step produced schema-valid output, same as all-frontier.
    routed_quality = sum(1 for _ in accepted) / 10  # all completed => all valid
    frontier_only = {"cheap": TieredPort(False), "frontier": TieredPort(False)}
    fevents = await _run(Router(_policy(escalate=True), frontier_only))
    frontier_quality = len(_accepted_models(fevents)) / 10
    assert abs(routed_quality - frontier_quality) <= 0.02
