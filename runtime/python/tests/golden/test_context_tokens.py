"""P3-4: the context compiler cuts >=25% of tokens vs naive concatenation (via top-k
memory + history summarization), the per-stage token breakdown is recorded, and the
assembled prompt is reconstructable from the log."""
import json
import pytest

from keel.kir.schema import Graph, Node, NodeType
from keel.substrate.ports import SystemClock, UlidIdGen, SeededRng, MemoryBlobStore
from keel.substrate.store.memory import MemoryEventStore
from keel.substrate.tracebus import TraceBus
from keel.substrate.events import EventType
from keel.executor.engine import Executor, RunContext
from keel.executor.state import RunState
from keel.services.context import ContextCompiler
from keel.services.model.handlers import make_llm_handler, MockModelPort


def _long_history(n: int) -> list[dict[str, str]]:
    return [{"role": "user" if i % 2 == 0 else "assistant",
             "content": f"turn {i}: " + "lorem ipsum dolor sit amet " * 8} for i in range(n)]


def test_compiler_reduces_tokens_at_least_25pct():
    cc = ContextCompiler(keep_recent_turns=3, top_k_memory=3)
    kw = dict(
        system="You are a careful assistant.",
        role="Role: researcher.",
        prompt="Summarize the discussion.",
        inputs="",
        history=_long_history(40),
        memory=[f"memory fact {i}: " + "detail " * 20 for i in range(12)],
    )
    compiled = cc.compile(**kw)
    naive = cc.naive_tokens(**kw)
    reduction = 1 - compiled.total_tokens / naive
    assert reduction >= 0.25, f"only {reduction*100:.1f}% reduction"
    # stage breakdown present and sums to the total
    assert set(compiled.stage_tokens) >= {"system", "role", "memory", "history", "inputs"}
    assert sum(compiled.stage_tokens.values()) == compiled.total_tokens


@pytest.mark.asyncio
async def test_stage_tokens_emitted_and_prompt_reconstructable():
    g = Graph(graph_id="g", nodes=[Node(id="n", type=NodeType.LLM_STEP, config={
        "model": "mock:test", "system": "sys", "prompt": "do it",
        "history": _long_history(20), "memory": ["m1", "m2", "m3", "m4"]})], edges=[])
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    handlers = {NodeType.LLM_STEP: make_llm_handler(MockModelPort())}
    ctx = RunContext("r", SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id="r", graph=g))
    await Executor(store, bus, blobs, handlers).run(g, ctx)
    await bus.flush()
    await bus.close()

    events = [e async for e in store.read_run("r")]
    req = next(e for e in events if e.type == EventType.LLM_REQUEST)
    assert "context_tokens" in req.data and req.data["context_total"] > 0
    # only top-3 memory items were included (the 4th was dropped)
    messages = json.loads(blobs.get(req.payload_ref))
    mem_msg = next(m for m in messages if "Relevant memory" in m["content"])
    assert "m1" in mem_msg["content"] and "m4" not in mem_msg["content"]
    # old turns were summarized rather than replayed verbatim
    assert any("summary of" in m["content"] for m in messages)
