"""Resume does not re-bill completed model calls.

Simulates a crash after the first step completes by persisting the log, then
folding it into a fresh RunState and continuing. Asserts the mock provider is NOT
called again for the already-completed node — the 'never re-billed' invariant.
"""
import pytest
from keel.kir.schema import Graph, Node, Edge, NodeType
from keel.substrate.ports import SystemClock, UlidIdGen, SeededRng, MemoryBlobStore
from keel.substrate.store.memory import MemoryEventStore
from keel.substrate.tracebus import TraceBus
from keel.executor.engine import Executor, RunContext
from keel.executor.state import RunState
from keel.services.model.handlers import make_llm_handler, MockModelPort


def _graph():
    return Graph(graph_id="g",
                 nodes=[Node(id="a", type=NodeType.LLM_STEP, config={"model": "m"}),
                        Node(id="b", type=NodeType.LLM_STEP, config={"model": "m"})],
                 edges=[Edge.model_validate({"from": "a", "to": "b"})])


@pytest.mark.asyncio
async def test_resume_does_not_rebill_completed_step():
    g = _graph()
    store = MemoryEventStore()
    blobs = MemoryBlobStore()
    model = MockModelPort()
    handlers = {NodeType.LLM_STEP: make_llm_handler(model)}

    # --- first attempt: run only node 'a' by stopping the loop early ---
    bus1 = TraceBus(store)
    await bus1.start()
    rid = "run-1"
    st1 = RunState(run_id=rid, graph=g)
    ctx1 = RunContext(rid, SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus1, st1)
    exec1 = Executor(store, bus1, blobs, handlers)
    # manually drive node 'a' to completion, then simulate crash
    from keel.substrate.events import EventType
    await ctx1.emit(EventType.RUN_STARTED)
    await exec1._run_node(g, ctx1, "a")
    await bus1.flush()
    await bus1.close()
    calls_after_a = model.calls
    assert calls_after_a == 1

    # --- crash & resume: fold persisted log, continue ---
    events = [e async for e in store.read_run(rid)]
    st2 = RunState.fold(rid, g, events)
    assert st2.steps["a"].status == "completed"
    bus2 = TraceBus(store)
    await bus2.start()
    ctx2 = RunContext(rid, SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus2, st2)
    final = await Executor(store, bus2, blobs, handlers).run(g, ctx2)
    await bus2.flush()
    await bus2.close()

    assert final.status == "completed"
    # 'a' was already done -> only 'b' should have called the model.
    assert model.calls == 2, f"completed step was re-billed (calls={model.calls})"
