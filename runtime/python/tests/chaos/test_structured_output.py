"""Structured-output enforcement (P1-7).

Acceptance: an adversarial model converges to typed success or a typed failure on
100% of runs; malformed JSON never reaches a downstream node.
"""
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
from keel.services.model.handlers import make_llm_handler, ScriptedModelPort, AdversarialModelPort


class Summary(BaseModel):
    title: str
    bullets: list[str]


@pytest.fixture(autouse=True)
def _registry():
    clear()
    register_schema(Summary)
    yield
    clear()


def _graph() -> Graph:
    return Graph(
        graph_id="g",
        nodes=[Node(id="s", type=NodeType.LLM_STEP, output_schema="ref:schemas/Summary",
                    config={"model": "mock:test"})],
        edges=[],
    )


async def _run(model):
    g = _graph()
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    handlers = {NodeType.LLM_STEP: make_llm_handler(model)}
    rid = "r1"
    ctx = RunContext(rid, SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id=rid, graph=g))
    final = await Executor(store, bus, blobs, handlers).run(g, ctx)
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run(rid)]
    return final, blobs, events


@pytest.mark.asyncio
async def test_converges_after_reprompt():
    # malformed text, schema-violating JSON, then valid -> re-prompt loop recovers.
    model = ScriptedModelPort(['not json', '{"title": 1}', '{"title": "T", "bullets": ["a"]}'])
    final, blobs, _ = await _run(model)
    assert final.status == "completed"
    assert model.calls == 3
    # Downstream sees the *validated, re-serialized* output, never the malformed text.
    out = blobs.get(final.steps["s"].result_ref)
    parsed = Summary.model_validate_json(out)
    assert parsed.title == "T" and parsed.bullets == ["a"]


@pytest.mark.asyncio
async def test_adversarial_fails_typed_never_leaks():
    model = AdversarialModelPort()
    final, _, events = await _run(model)
    assert final.status == "failed"
    failed = [e for e in events if e.type == EventType.STEP_FAILED]
    assert failed, "expected a typed STEP_FAILED"
    assert "structured_output_unsatisfied" in failed[0].data["error"]["msg"]
    # No STEP_COMPLETED for the schema-enforced node -> nothing leaked downstream.
    assert not [e for e in events if e.type == EventType.STEP_COMPLETED]
    assert model.calls == 3  # MAX_REPROMPTS + 1
