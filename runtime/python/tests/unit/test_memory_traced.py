"""P2-9: memory reads/writes are traced events; the retrieved context is
reconstructable from the log; a disable flag makes memory inert."""
import json
import pytest

from keel.kir.schema import Graph, Node, NodeType
from keel.substrate.ports import SystemClock, UlidIdGen, SeededRng, MemoryBlobStore
from keel.substrate.store.memory import MemoryEventStore
from keel.substrate.tracebus import TraceBus
from keel.substrate.events import EventType
from keel.executor.engine import RunContext
from keel.executor.state import RunState
from keel.services.memory import TracedMemory, HashEmbedder


async def _ctx():
    g = Graph(graph_id="g", nodes=[Node(id="n", type=NodeType.LLM_STEP)], edges=[])
    store = MemoryEventStore()
    bus = TraceBus(store)
    await bus.start()
    blobs = MemoryBlobStore()
    ctx = RunContext("r", SystemClock(), UlidIdGen(), SeededRng(0), blobs, bus,
                     RunState(run_id="r", graph=g))
    return ctx, store, bus, blobs


@pytest.mark.asyncio
async def test_kv_and_vector_ops_are_traced_and_reconstructable():
    ctx, store, bus, blobs = await _ctx()
    mem = TracedMemory(ctx, embedder=HashEmbedder(), node_id="n")
    await mem.remember("topic", "graph databases")
    assert await mem.recall("topic") == "graph databases"
    await mem.index("d1", "vector search is great")
    await mem.index("d2", "graph databases store edges")
    hits = await mem.search("graph databases", k=1)
    await bus.flush()
    await bus.close()

    assert hits and hits[0][0] == "d2"
    events = [e async for e in store.read_run("r")]
    reads = [e for e in events if e.type == EventType.MEMORY_READ]
    writes = [e for e in events if e.type == EventType.MEMORY_WRITE]
    assert len(writes) == 3 and len(reads) == 2  # kv recall + vector search

    # The retrieved context is in the log: the vector-search read carries the hits.
    search_read = [e for e in reads if e.data.get("kind") == "vector"][0]
    payload = json.loads(blobs.get(search_read.payload_ref))
    assert payload[0]["doc_id"] == "d2"


@pytest.mark.asyncio
async def test_disabled_memory_is_inert():
    ctx, store, bus, blobs = await _ctx()
    mem = TracedMemory(ctx, enabled=False, node_id="n")
    await mem.remember("k", "v")
    assert await mem.recall("k") is None
    assert await mem.search("anything") == []
    await bus.flush()
    await bus.close()
    events = [e async for e in store.read_run("r")]
    assert not [e for e in events if e.type in (EventType.MEMORY_READ, EventType.MEMORY_WRITE)]
